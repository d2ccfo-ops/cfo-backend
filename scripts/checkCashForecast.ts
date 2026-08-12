import { prisma } from "../src/lib/prisma.js";
import { getCashForecast } from "../src/modules/calc/cashForecast.js";

// Read-only. Run with: npx tsx scripts/checkCashForecast.ts

const rupees = (paise: string | bigint) =>
  "₹" + (Number(paise) / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 });

async function main() {
  const orgs = await prisma.organization.findMany({ select: { id: true, name: true, timezone: true } });

  for (const org of orgs) {
    const orderCount = await prisma.order.count({ where: { organizationId: org.id } });
    if (orderCount === 0) continue;

    console.log(`\n=== ${org.name} (${org.timezone}) ===`);
    const t0 = Date.now();
    const f = await getCashForecast(org.id, org.timezone);
    console.log(`computed in ${Date.now() - t0}ms`);

    console.log(`reliability: ${f.reliability}`);
    console.log(`  ${f.reliabilityNote}`);
    console.log(`opening: ${rupees(f.openingBalance.valueMinor)} (${f.openingBalance.basis})`);
    console.log(
      `totals over ${f.horizonDays}d: inflow ${rupees(f.totals.inflowMinor)}, outflow ${rupees(f.totals.outflowMinor)}, closing ${rupees(f.totals.closingMinor)}`
    );

    console.log("components:");
    for (const c of f.components) {
      console.log(`  ${c.basis.padEnd(12)} ${c.label.padEnd(34)} ${rupees(c.valueMinor).padStart(14)}`);
    }

    console.log("first 10 days:");
    for (const d of f.days.slice(0, 10)) {
      const weekday = new Date(`${d.date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
      console.log(
        `  ${d.date} ${weekday}  in ${rupees(d.inflowMinor).padStart(12)} (placed ${rupees(d.inflowFromPlacedOrdersMinor).padStart(11)} / proj ${rupees(d.inflowFromProjectedOrdersMinor).padStart(11)})  out ${rupees(d.outflowMinor).padStart(10)}  close ${rupees(d.closingMinor).padStart(13)}`
      );
    }

    // --- Invariants -------------------------------------------------------
    let ok = true;
    let running = BigInt(f.openingBalance.valueMinor);
    let inSum = 0n;
    let outSum = 0n;
    for (const d of f.days) {
      if (d.openingMinor !== running.toString()) {
        console.log(`  ✗ opening mismatch on ${d.date}: ${d.openingMinor} vs ${running}`);
        ok = false;
      }
      const expectedClose = running + BigInt(d.inflowMinor) - BigInt(d.outflowMinor);
      if (d.closingMinor !== expectedClose.toString()) {
        console.log(`  ✗ closing mismatch on ${d.date}`);
        ok = false;
      }
      if (BigInt(d.inflowFromPlacedOrdersMinor) + BigInt(d.inflowFromProjectedOrdersMinor) !== BigInt(d.inflowMinor)) {
        console.log(`  ✗ inflow split does not sum on ${d.date}`);
        ok = false;
      }
      running = expectedClose;
      inSum += BigInt(d.inflowMinor);
      outSum += BigInt(d.outflowMinor);
    }
    if (inSum.toString() !== f.totals.inflowMinor) { console.log("  ✗ inflow total mismatch"); ok = false; }
    if (outSum.toString() !== f.totals.outflowMinor) { console.log("  ✗ outflow total mismatch"); ok = false; }
    if (running.toString() !== f.totals.closingMinor) { console.log("  ✗ closing total mismatch"); ok = false; }
    if (f.days.length !== f.horizonDays) { console.log("  ✗ wrong number of days"); ok = false; }
    if (new Set(f.days.map((d) => d.date)).size !== f.days.length) { console.log("  ✗ duplicate dates"); ok = false; }

    // No day may count the same order both as already-placed and as projected.
    const overlap = f.days.filter(
      (d) => BigInt(d.inflowFromPlacedOrdersMinor) > 0n && BigInt(d.inflowFromProjectedOrdersMinor) > 0n
    );
    console.log(`  days with both placed and projected inflow: ${overlap.length} (expected: the lag transition only)`);

    console.log(ok ? "  ✓ all invariants hold" : "  ✗ invariants FAILED");

    // --- Sanity: does projected daily inflow resemble actual order value? ---
    const last28 = await prisma.$queryRaw<{ total: bigint }[]>`
      SELECT sum(o."grossAmount" - o."refundedAmount")::bigint AS total
      FROM orders o
      WHERE o."organizationId" = ${org.id}
        AND o."cancelledAt" IS NULL
        AND o."placedAt" >= now() - interval '28 days'`;
    const actualDaily = (last28[0]?.total ?? 0n) / 28n;
    const projectedDaily = BigInt(f.totals.inflowMinor) / BigInt(f.horizonDays);
    console.log(
      `  actual trailing daily order value ${rupees(actualDaily)} vs forecast daily inflow ${rupees(projectedDaily)}`
    );
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
