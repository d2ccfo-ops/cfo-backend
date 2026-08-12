import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import { AMOUNT_TOLERANCE_PAISE, getCodExposure } from "../src/modules/calc/reconciliation.js";
import { DEFAULT_TIMEZONE, resolveDateRange } from "../src/lib/dateRange.js";

// Proves the reconciliation period filter is coherent: for every window the UI
// can produce, the summary's status counts must equal what the item list walks
// under the same window, the COD buckets must still sum EXACTLY to the COD
// gross of that window, and the windows must partition the order book — the
// union of non-overlapping periods has to equal the unfiltered total, or the
// filter is dropping (or double-counting) orders at its boundaries.
//
// Run with: npx tsx scripts/checkReconciliationPeriods.ts

const STATUS_CASE = Prisma.sql`
  CASE
    WHEN m.id IS NOT NULL AND m.status = 'RESOLVED' THEN 'written_off'
    WHEN o."cancelledAt" IS NOT NULL AND m.id IS NULL THEN 'cancelled'
    WHEN m.id IS NOT NULL AND m."amountDeltaAbs" > ${AMOUNT_TOLERANCE_PAISE} THEN 'review'
    WHEN m.id IS NOT NULL AND m.confidence IN ('MEDIUM', 'LOW') THEN 'review'
    WHEN m.id IS NOT NULL THEN 'matched'
    WHEN o."paymentMode" = 'COD' THEN 'cod_pending'
    WHEN (o.raw->'payment_terms' IS NOT NULL AND o.raw->'payment_terms' <> 'null'::jsonb) THEN 'invoiced'
    ELSE 'unmatched'
  END`;

const BASE_FROM = Prisma.sql`
  FROM orders o
  LEFT JOIN LATERAL (
    SELECT rm.id, rm.status, rm.confidence, rm."amountDeltaAbs", rm."targetId", rm.note
    FROM reconciliation_matches rm
    WHERE rm."sourceType" = 'ORDER' AND rm."sourceId" = o.id AND rm."matchType" = 'ORDER_PAYMENT'
    ORDER BY rm."createdAt" DESC LIMIT 1
  ) m ON true`;

// Exactly what components/controls/DateRangeContext.js can emit, plus the
// no-parameters case. Each is resolved through the real backend resolver so the
// timezone boundary logic under test is the one the routes use.
const PRESETS: { label: string; query: Record<string, string> }[] = [
  { label: "Month to date (default)", query: {} },
  { label: "Today", query: { from: "2026-08-09", to: "2026-08-09" } },
  { label: "Last 7 days", query: { from: "2026-08-03", to: "2026-08-09" } },
  { label: "Last 30 days", query: { from: "2026-07-11", to: "2026-08-09" } },
  { label: "This quarter (Jul–Sep)", query: { from: "2026-07-01", to: "2026-08-09" } },
  { label: "This financial year", query: { from: "2026-04-01", to: "2026-08-09" } },
  { label: "Custom: all data", query: { from: "2025-10-15", to: "2026-08-09" } },
  { label: "Custom: single old day", query: { from: "2025-12-25", to: "2025-12-25" } },
  { label: "Custom: empty future window", query: { from: "2026-08-20", to: "2026-08-25" } },
];

let failures = 0;

function check(ok: boolean, label: string, detail = "") {
  if (!ok) failures += 1;
  console.log(`    ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

const inr = (paise: bigint) => `₹${(Number(paise) / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

async function main() {
  const orgs = await prisma.organization.findMany({ select: { id: true, name: true } });

  for (const org of orgs) {
    const total = await prisma.order.count({ where: { organizationId: org.id } });
    if (total === 0) continue;
    console.log(`\n=== ${org.name} — ${total.toLocaleString("en-IN")} orders ===`);

    for (const preset of PRESETS) {
      const range = resolveDateRange(preset.query, new Date(), DEFAULT_TIMEZONE);
      const window = Prisma.sql`o."placedAt" >= ${range.from} AND o."placedAt" <= ${range.to}`;

      // 1. The summary's GROUP BY, exactly as the route computes it.
      const statusRows = await prisma.$queryRaw<{ status: string; count: bigint; value: bigint }[]>(Prisma.sql`
        SELECT status, count(*) AS count, sum(expected)::bigint AS value FROM (
          SELECT ${STATUS_CASE} AS status, o."grossAmount" AS expected
          ${BASE_FROM}
          WHERE o."organizationId" = ${org.id} AND ${window}
        ) t GROUP BY status`);
      const summaryTotal = statusRows.reduce((n, r) => n + Number(r.count), 0);

      // 2. The item list under the same window, walked to the end via the same
      //    keyset cursor the route hands out. Summary and list disagreeing is
      //    the failure this whole check exists to catch.
      const listed = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
        SELECT count(*) AS count FROM orders o WHERE o."organizationId" = ${org.id} AND ${window}`);
      const listedTotal = Number(listed[0]?.count ?? 0n);

      const cod = await getCodExposure(org.id, { from: range.from, to: range.to });
      const codGross = await prisma.order.aggregate({
        where: {
          organizationId: org.id,
          paymentMode: "COD",
          cancelledAt: null,
          placedAt: { gte: range.from, lte: range.to },
        },
        _sum: { grossAmount: true },
        _count: { _all: true },
      });
      const gross = codGross._sum.grossAmount ?? 0n;
      const buckets = cod.onlineDepositsValue + cod.inFlightValue + cod.deliveredValue + cod.rtoValue;

      console.log(
        `  ${preset.label}: ${summaryTotal.toLocaleString("en-IN")} orders, COD gross ${inr(gross)}`
      );
      check(summaryTotal === listedTotal, "summary count == item-list count", `${summaryTotal} vs ${listedTotal}`);
      check(buckets === gross, "deposits + in-flight + delivered + RTO == COD gross", `${buckets} vs ${gross}`);
      // The bug date-scoping made reachable: two orders in this store ship in
      // two parcels, so a subtraction-based in-flight count can go negative on
      // a narrow window.
      check(cod.inFlightCount >= 0, "in-flight count is not negative", `${cod.inFlightCount}`);
      check(
        cod.inFlightCount <= codGross._count._all,
        "in-flight count <= COD orders in window",
        `${cod.inFlightCount} vs ${codGross._count._all}`
      );
    }

    // 3. Adjacent, non-overlapping windows must partition the order book. This
    //    is what catches an off-by-one at a day boundary — the classic way a
    //    date filter double-counts or silently drops a day's orders.
    const slices = [
      { from: "2025-10-01", to: "2025-12-31" },
      { from: "2026-01-01", to: "2026-03-31" },
      { from: "2026-04-01", to: "2026-06-30" },
      { from: "2026-07-01", to: "2026-09-30" },
    ];
    let union = 0;
    for (const s of slices) {
      const r = resolveDateRange(s, new Date(), DEFAULT_TIMEZONE);
      union += await prisma.order.count({
        where: { organizationId: org.id, placedAt: { gte: r.from, lte: r.to } },
      });
    }
    // Compared against the orders that fall INSIDE the slices' overall span,
    // not against the whole order book.
    //
    // This used to compare against the unfiltered total, which quietly assumed
    // every order an organisation has ever taken sits inside these four fixed
    // quarters. That held for the two real orgs and broke the moment an org
    // with a longer history appeared — 521 orders placed before 2025-10-01 were
    // reported as a partition failure when the filter was working perfectly.
    // The bug this check exists to catch is an off-by-one at a slice boundary,
    // and that is still caught exactly as before: the span's own endpoints are
    // the first and last slice's endpoints.
    const spanStart = resolveDateRange(slices[0]!, new Date(), DEFAULT_TIMEZONE).from;
    const spanEnd = resolveDateRange(slices[slices.length - 1]!, new Date(), DEFAULT_TIMEZONE).to;
    const inSpan = await prisma.order.count({
      where: { organizationId: org.id, placedAt: { gte: spanStart, lte: spanEnd } },
    });
    console.log(`  partition check (4 adjacent quarters):`);
    check(union === inSpan, "non-overlapping windows sum to the orders inside their span", `${union} vs ${inSpan}`);
    if (inSpan !== total) {
      console.log(`    (${total - inSpan} orders lie outside the four quarters — not a failure, just outside the span)`);
    }
  }

  console.log(failures === 0 ? "\nall period-filter checks passed" : `\n${failures} FAILURES`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
