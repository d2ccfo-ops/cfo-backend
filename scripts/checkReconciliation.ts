import { prisma } from "../src/lib/prisma.js";
import { runReconciliation, getCodExposure } from "../src/modules/calc/reconciliation.js";

// Read-only-ish verification of the reconciliation engine against whatever is
// really in Postgres. Run with: npx tsx scripts/checkReconciliation.ts

const rupees = (paise: bigint | number) => "₹" + (Number(paise) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });

async function main() {
  const orgs = await prisma.organization.findMany({ select: { id: true, name: true } });

  for (const org of orgs) {
    const orderCount = await prisma.order.count({ where: { organizationId: org.id } });
    if (orderCount === 0) continue;

    console.log(`\n=== ${org.name} (${org.id}) — ${orderCount.toLocaleString("en-IN")} orders ===`);

    const t0 = Date.now();
    const result = await runReconciliation(org.id);
    console.log(`run: ${result.durationMs}ms, created ${result.created} match rows`);

    for (const leg of result.legs) {
      const head = `  ${leg.matchType.padEnd(20)} ${leg.state.padEnd(12)}`;
      if (leg.state === "unavailable") {
        console.log(`${head} eligible=${leg.eligible}  — ${leg.blockedReason}`);
      } else {
        console.log(
          `${head} eligible=${leg.eligible} matched=${leg.matched} review=${leg.needsReview} unmatched=${leg.unmatched}  matchedValue=${rupees(leg.matchedValue)}`
        );
      }
    }

    const cod = await getCodExposure(org.id);
    console.log(
      `  COD exposure: in-flight ${cod.inFlightCount} (${rupees(cod.inFlightValue)}), delivered ${cod.deliveredCount} (${rupees(cod.deliveredValue)}), courier data: ${cod.hasCourierData}`
    );

    // --- The two SQL shapes the route depends on, exercised directly. -------
    const statusRows = await prisma.$queryRawUnsafe<{ status: string; count: bigint; value: bigint }[]>(
      `SELECT status, count(*) AS count, sum(expected)::bigint AS value FROM (
         SELECT CASE
           WHEN m.id IS NOT NULL AND m.status = 'RESOLVED' THEN 'written_off'
           WHEN o."cancelledAt" IS NOT NULL AND m.id IS NULL THEN 'cancelled'
           WHEN m.id IS NOT NULL AND m."amountDeltaAbs" > 100 THEN 'review'
           WHEN m.id IS NOT NULL AND m.confidence IN ('MEDIUM','LOW') THEN 'review'
           WHEN m.id IS NOT NULL THEN 'matched'
           WHEN o."paymentMode" = 'COD' THEN 'cod_pending'
           ELSE 'unmatched' END AS status,
           o."grossAmount" AS expected
         FROM orders o
         LEFT JOIN LATERAL (
           SELECT rm.id, rm.status, rm.confidence, rm."amountDeltaAbs", rm."targetId"
           FROM reconciliation_matches rm
           WHERE rm."sourceType"='ORDER' AND rm."sourceId"=o.id AND rm."matchType"='ORDER_PAYMENT'
           ORDER BY rm."createdAt" DESC LIMIT 1
         ) m ON true
         WHERE o."organizationId" = $1
       ) t GROUP BY status ORDER BY count DESC`,
      org.id
    );
    console.log("  status breakdown:");
    for (const r of statusRows) {
      console.log(`    ${r.status.padEnd(14)} ${String(r.count).padStart(7)}  ${rupees(r.value ?? 0n)}`);
    }

    // --- Keyset pagination: walk every page and prove no dupes, no gaps. ----
    let cursor: { placedAt: Date; id: string } | null = null;
    const seen = new Set<string>();
    let pages = 0;
    let dupes = 0;
    const pageStart = Date.now();

    for (;;) {
      const rows: { id: string; placed_at: Date }[] = cursor
        ? await prisma.$queryRawUnsafe(
            `SELECT o.id, o."placedAt" AS placed_at FROM orders o
             WHERE o."organizationId" = $1 AND (o."placedAt", o.id) < ($2::timestamp, $3)
             ORDER BY o."placedAt" DESC, o.id DESC LIMIT 500`,
            org.id,
            cursor.placedAt,
            cursor.id
          )
        : await prisma.$queryRawUnsafe(
            `SELECT o.id, o."placedAt" AS placed_at FROM orders o
             WHERE o."organizationId" = $1
             ORDER BY o."placedAt" DESC, o.id DESC LIMIT 500`,
            org.id
          );

      if (rows.length === 0) break;
      for (const r of rows) {
        if (seen.has(r.id)) dupes += 1;
        seen.add(r.id);
      }
      const last = rows[rows.length - 1]!;
      cursor = { placedAt: last.placed_at, id: last.id };
      pages += 1;
      if (pages > 500) break;
    }

    console.log(
      `  keyset walk: ${pages} pages, ${seen.size.toLocaleString("en-IN")} distinct rows, ${dupes} duplicates, ${Date.now() - pageStart}ms`
    );
    console.log(`  expected ${orderCount.toLocaleString("en-IN")} — ${seen.size === orderCount ? "MATCHES" : "MISMATCH"}`);
    console.log(`  total ${Date.now() - t0}ms`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
