import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import { AMOUNT_TOLERANCE_PAISE } from "../src/modules/calc/reconciliation.js";

// Exercises the exact SQL routes/reconciliation.ts builds for GET /items —
// every status filter, and a full cursor walk under one of them — against real
// data. The status filter repeats a derived CASE inside WHERE, which is the
// part most likely to silently disagree with the label the row carries.
//
// Run with: npx tsx scripts/checkReconciliationItems.ts

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
  ) m ON true
  LEFT JOIN payments p ON p.id = m."targetId"`;

const STATUSES = ["matched", "review", "unmatched", "cod_pending", "invoiced", "written_off", "cancelled"] as const;

interface Row {
  id: string;
  placed_at: Date;
  status: string;
  payment_mode: string | null;
  expected: bigint;
  received: bigint | null;
}

async function page(organizationId: string, status: string | null, cursor: Row | null, limit: number) {
  const conditions: Prisma.Sql[] = [Prisma.sql`o."organizationId" = ${organizationId}`];
  if (cursor) {
    conditions.push(Prisma.sql`(o."placedAt", o.id) < (${cursor.placed_at}::timestamp, ${cursor.id})`);
  }
  if (status) conditions.push(Prisma.sql`${STATUS_CASE} = ${status}`);

  // The paid lateral must stay shape-identical to the route's, ::bigint cast
  // included: sum(bigint) is numeric in Postgres, which Prisma returns as a
  // Decimal, and Decimal minus BigInt throws at response-mapping time. That
  // exact miss crashed the API while this script — then lateral-less — passed.
  return prisma.$queryRaw<Row[]>(Prisma.sql`
    SELECT o.id, o."placedAt" AS placed_at, o."paymentMode" AS payment_mode,
           o."grossAmount" AS expected, paid.amount AS received, ${STATUS_CASE} AS status
    ${BASE_FROM}
    LEFT JOIN LATERAL (
      SELECT sum(p2.amount)::bigint AS amount FROM payments p2
      WHERE p2."orderId" = o.id AND p2.status = 'captured'
    ) paid ON true
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY o."placedAt" DESC, o.id DESC
    LIMIT ${limit}`);
}

async function main() {
  const orgs = await prisma.organization.findMany({ select: { id: true, name: true } });
  let failures = 0;

  for (const org of orgs) {
    const total = await prisma.order.count({ where: { organizationId: org.id } });
    if (total === 0) continue;
    console.log(`\n=== ${org.name} — ${total.toLocaleString("en-IN")} orders ===`);

    // Ground truth for each status, straight from a GROUP BY.
    const truth = await prisma.$queryRaw<{ status: string; count: bigint }[]>(Prisma.sql`
      SELECT status, count(*) AS count FROM (
        SELECT ${STATUS_CASE} AS status ${BASE_FROM} WHERE o."organizationId" = ${org.id}
      ) t GROUP BY status`);
    const truthByStatus = new Map(truth.map((t) => [t.status, Number(t.count)]));

    for (const status of STATUSES) {
      const expected = truthByStatus.get(status) ?? 0;
      const t0 = Date.now();

      // Full cursor walk under this filter — the thing that broke when the
      // filter sat outside a LIMITed subquery.
      const seen = new Set<string>();
      let cursor: Row | null = null;
      let pages = 0;
      let mislabeled = 0;
      let dupes = 0;
      let badTypes = 0;
      let withDeposit = 0;

      for (;;) {
        const rows = await page(org.id, status, cursor, 500);
        if (rows.length === 0) break;
        for (const r of rows) {
          if (seen.has(r.id)) dupes += 1;
          seen.add(r.id);
          if (r.status !== status) mislabeled += 1;
          // The route's response mapping, verbatim — subtraction across a
          // Decimal/BigInt mismatch is what killed the process, so every row
          // must survive it here.
          if (typeof r.expected !== "bigint") badTypes += 1;
          if (r.received !== null) {
            if (typeof r.received !== "bigint") badTypes += 1;
            else {
              void (r.received - r.expected).toString();
              if (r.received > 0n) withDeposit += 1;
            }
          }
        }
        cursor = rows[rows.length - 1]!;
        pages += 1;
        if (pages > 400) break;
      }

      const ok = seen.size === expected && dupes === 0 && mislabeled === 0 && badTypes === 0;
      if (!ok) failures += 1;
      console.log(
        `  ${ok ? "✓" : "✗"} ${status.padEnd(13)} walked ${String(seen.size).padStart(6)} / expected ${String(expected).padStart(6)}  pages=${String(pages).padStart(3)}  dupes=${dupes}  mislabeled=${mislabeled}  badTypes=${badTypes}  received>0: ${withDeposit}  ${Date.now() - t0}ms`
      );
    }

    // Unfiltered walk must equal the sum of the filtered walks.
    const unfilteredFirst = await page(org.id, null, null, 100);
    const allStatusesSeen = new Set(unfilteredFirst.map((r) => r.status));
    console.log(`  first unfiltered page: ${unfilteredFirst.length} rows, statuses present: ${[...allStatusesSeen].join(", ")}`);

    // A COD order must never be labelled "unmatched" — that distinction is the
    // whole point of the CASE ordering.
    const codMislabeled = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
      SELECT count(*) AS count FROM (
        SELECT ${STATUS_CASE} AS status, o."paymentMode" AS mode ${BASE_FROM}
        WHERE o."organizationId" = ${org.id}
      ) t WHERE t.mode = 'COD' AND t.status = 'unmatched'`);
    const bad = Number(codMislabeled[0]?.count ?? 0n);
    if (bad > 0) failures += 1;
    console.log(`  ${bad === 0 ? "✓" : "✗"} COD orders labelled "unmatched": ${bad} (must be 0)`);

    // The same distinction for invoices. An order raised on payment terms
    // never had a checkout payment to lose, so labelling it "no payment found"
    // reports a failure that did not happen — which is exactly what this store
    // was doing for all 145 of them (₹15.19 L).
    const invoiceMislabeled = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
      SELECT count(*) AS count FROM (
        SELECT ${STATUS_CASE} AS status,
               (o.raw->'payment_terms' IS NOT NULL AND o.raw->'payment_terms' <> 'null'::jsonb) AS has_terms
        ${BASE_FROM}
        WHERE o."organizationId" = ${org.id}
      ) t WHERE t.has_terms AND t.status = 'unmatched'`);
    const badInvoices = Number(invoiceMislabeled[0]?.count ?? 0n);
    if (badInvoices > 0) failures += 1;
    console.log(`  ${badInvoices === 0 ? "✓" : "✗"} orders on payment terms labelled "unmatched": ${badInvoices} (must be 0)`);

    // And the converse: nothing WITHOUT payment terms may be called an invoice,
    // or the new status would quietly absorb real payment failures.
    const invoiceOverreach = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
      SELECT count(*) AS count FROM (
        SELECT ${STATUS_CASE} AS status,
               (o.raw->'payment_terms' IS NOT NULL AND o.raw->'payment_terms' <> 'null'::jsonb) AS has_terms
        ${BASE_FROM}
        WHERE o."organizationId" = ${org.id}
      ) t WHERE NOT t.has_terms AND t.status = 'invoiced'`);
    const overreach = Number(invoiceOverreach[0]?.count ?? 0n);
    if (overreach > 0) failures += 1;
    console.log(`  ${overreach === 0 ? "✓" : "✗"} orders WITHOUT payment terms labelled "invoiced": ${overreach} (must be 0)`);
  }

  console.log(failures === 0 ? "\nall item queries correct" : `\n${failures} FAILURES`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
