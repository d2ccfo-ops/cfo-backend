import { prisma } from "../src/lib/prisma.js";
import { importAdSpendCsv } from "../src/modules/connectors/adspend/csv.js";
import { findDemoOrg } from "./lib/demoOrg.js";

// Ad-spend CSV import, against the shapes Meta and Google ACTUALLY emit.
//
// Every case below is one a real upload hit. The importer was written against
// an assumed shape and was wrong three separate times:
//
//   1. Meta's daily export keeps "Reporting starts/ends" as the report's whole
//      range and adds "Day" beside it — so an aggregate check comparing those
//      two columns rejected exactly the file the product asks people to make.
//   2. Google Ads opens with title/date-range rows, so the column names are on
//      line 3, not line 1.
//   3. Both providers restate the money in summary rows — Meta as a blank-name
//      account total, Google as a trailing "Total: account" — and importing
//      either double-counts the whole file.
//
// Uses a throwaway connection in the DEMO org and deletes it afterwards. It
// must never touch an org holding real data, and it must not reuse the demo
// seeder's own connection — deleting by connectionId once destroyed 365 seeded
// rows that way.
//
// Run with: npx tsx scripts/checkAdSpendCsv.ts

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(label: string, condition: boolean, detail = "") {
  if (condition) pass += 1;
  else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  }
  console.log(`  ${condition ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}
const inr = (p: bigint | number) => "₹" + (Number(p) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });

async function main() {
  const org = await findDemoOrg();
  if (!org) {
    console.log("no demo organisation — run scripts/seedDemoData.ts first");
    process.exit(1);
  }
  const le = (await prisma.legalEntity.findFirst({ where: { organizationId: org.id } }))!;
  const before = await prisma.adSpend.count({ where: { organizationId: org.id } });

  const conn = await prisma.connection.create({
    data: {
      organizationId: org.id,
      legalEntityId: le.id,
      provider: "META_ADS",
      status: "ACTIVE",
      externalAccountId: "csv-test",
      credentialsRef: "demo-seed:adspend-csv-check",
    },
  });
  const ctx = {
    connectionId: conn.id,
    organizationId: org.id,
    legalEntityId: le.id,
    externalAccountId: "csv-test",
    provider: "META_ADS" as const,
  };
  console.log(`\n=== ${org.name} ===`);

  try {
    // --- 1. Meta's DEFAULT export: aggregated, must be refused -----------
    console.log("\n[1] Meta default export (aggregated over the whole range)");
    const agg = [
      '"Reporting starts","Reporting ends","Ad set name","Amount spent (INR)",Impressions',
      "2025-12-10,2026-08-10,,2865622.15,61572667",
      '2025-12-10,2026-08-10,"Jewellery / HH / BHAV",968889.01,37720787',
    ].join("\n");
    const r1 = await importAdSpendCsv(ctx, agg);
    ok("nothing imported", r1.daysImported === 0, `${r1.daysImported} days`);
    ok("refusal explains how to re-export", r1.errors.some((e) => /broken down by day/i.test(e)), r1.errors[0] ?? "no error");

    // --- 2. Meta's DAILY export ------------------------------------------
    // The range columns are still present and still span the whole report;
    // only the added "Day" column describes the row.
    console.log("\n[2] Meta daily export (Day column beside the full range)");
    const daily = [
      '"Reporting starts","Reporting ends","Ad set name","Day","Amount spent (INR)",Impressions,"Link clicks"',
      "2025-12-10,2026-08-10,,2026-08-01,15000.00,500000,4000",
      '2025-12-10,2026-08-10,"Set A",2026-08-01,9000.00,300000,2500',
      '2025-12-10,2026-08-10,"Set B",2026-08-01,6000.00,200000,1500',
      '2025-12-10,2026-08-10,"Set A",2026-08-02,11000.50,340000,2700',
    ].join("\n");
    const r2 = await importAdSpendCsv(ctx, daily);
    ok("imports despite the range columns", r2.errors.length === 0, r2.errors.join("; "));
    ok("one row per day", r2.daysImported === 2, `${r2.daysImported}`);
    ok("account-total row skipped", r2.rowsSkipped === 1, `${r2.rowsSkipped}`);
    // 01 Aug: 9,000 + 6,000 = 15,000 (the 15,000 account-total row is NOT
    // added on top). 02 Aug: 11,000.50. Total 26,000.50 — which is also the
    // proof the total row was excluded, since including it would give 41,000.50.
    ok("ad sets summed per day, total excluded", r2.totalSpendPaise === 2600050n, inr(r2.totalSpendPaise));

    // --- 3. Google Ads: preamble rows + trailing total -------------------
    console.log("\n[3] Google Ads export (title rows, then header, then a total)");
    const gads = [
      '"Campaign report"',
      '"Aug 1, 2026 - Aug 3, 2026"',
      "Day,Campaign,Cost,Impr.,Clicks",
      "2026-08-01,Brand - Search,1200.50,15000,320",
      "2026-08-01,Shopping - PMax,800.25,22000,410",
      "2026-08-02,Brand - Search,1100.00,14000,300",
      '"Total: account",,3100.75,51000,1030',
    ].join("\n");
    const r3 = await importAdSpendCsv({ ...ctx, provider: "GOOGLE_ADS" }, gads);
    ok("header found below the preamble", r3.errors.length === 0, r3.errors.join("; "));
    ok("two days imported", r3.daysImported === 2, `${r3.daysImported}`);
    ok("trailing total row skipped", r3.rowsSkipped === 1, `${r3.rowsSkipped}`);
    ok("total not double-counted", r3.totalSpendPaise === 310075n, inr(r3.totalSpendPaise));

    // --- 3b. The REAL Google "Campaign report" ---------------------------
    // Verbatim from the merchant's export: a 31-column header on line 3, an
    // "All time" period line, no Day column anywhere, and seven "Total: …"
    // summary rows. Requiring a date column to FIND the header meant this file
    // reported `Found: Campaign report` and hid the real problem.
    console.log("\n[3b] the real Google Ads 'Campaign report' (no Day column)");
    const REAL_GADS_HEADER =
      "Campaign status,Campaign,Budget,Budget name,Budget type,Currency code,Status,Status reasons," +
      "Optimization score,Campaign type,Bid strategy type,Conv. value / cost,Avg. target ROAS,Conv. value," +
      "TrueView views,Impr.,TrueView avg. CPV,Conversions,Conv. rate,Cost / conv.,Clicks,CTR," +
      "Conv. (Platform Comparable),Conv. value / Cost (Platform Comparable),Unique users,Avg. CPM,Cost," +
      "Likes,Comments,Shares,Goals";
    const realGads = [
      "Campaign report",
      "All time",
      REAL_GADS_HEADER,
      'Enabled,LR | PMAX | Gemstones | 13-05-2026,1000.00, --,Daily,INR,Eligible (Limited),some asset groups limited by policy,78.46,Performance Max,Maximize Conversions,2.51, --,"224,144.69","2,004","1,103,153",0.20,108.29,0.49%,825.93,"16,463",1.49%,0.00,0.00,,81.08,89440.42,0,0,0,Purchase (Website)',
      'Total: Account,,,,,INR,,,,,,1.71, --,"4,516,727.66","417,897","22,142,777",0.44,"10,174.50",0.97%,259.20,"457,813",2.07%,272.00,0.16,,119.10,2637278.05,"1,920",0,170,',
    ].join("\n");
    const r3b = await importAdSpendCsv({ ...ctx, provider: "GOOGLE_ADS" }, realGads);
    ok("refused — no per-day column", r3b.daysImported === 0, `${r3b.daysImported} days`);
    ok("says the report has no per-day column", r3b.errors.some((e) => /no per-day column/i.test(e)), r3b.errors[0] ?? "none");
    ok('quotes the period back ("All time")', r3b.errors.some((e) => e.includes("All time")), r3b.errors[0] ?? "none");
    ok("does NOT claim the header is 'Campaign report'",
      !r3b.errors.some((e) => /Found: Campaign report/.test(e)), r3b.errors[0] ?? "none");

    // The same report WITH the Day segment added is what we ask people for.
    console.log("\n[3c] the same report with the Day segment added");
    const realGadsDaily = [
      "Campaign report",
      "Aug 1, 2026 - Aug 2, 2026",
      `Day,${REAL_GADS_HEADER}`,
      '2026-08-01,Enabled,LR | PMAX | Gemstones,1000.00, --,Daily,INR,Eligible,,78.46,Performance Max,Maximize Conversions,2.51, --,"224,144.69","2,004","1,103,153",0.20,108.29,0.49%,825.93,"16,463",1.49%,0.00,0.00,,81.08,50000.00,0,0,0,Purchase (Website)',
      '2026-08-01,Enabled,FTA_Shopping_Mala,1001.00, --,Daily,INR,Eligible,,98.50,Shopping,Target ROAS,1.92,198.75%,"429,102.61",0,"1,424,070",0,348.98,1.52%,639.98,"22,966",1.61%,0.00,0.00,,156.83,30000.00,0,0,0,6455556034',
      '2026-08-02,Enabled,LR | PMAX | Gemstones,1000.00, --,Daily,INR,Eligible,,78.46,Performance Max,Maximize Conversions,2.51, --,"224,144.69","2,004","1,103,153",0.20,108.29,0.49%,825.93,"16,463",1.49%,0.00,0.00,,81.08,45500.75,0,0,0,Purchase (Website)',
      'Total: Account,,,,,,INR,,,,,,1.71, --,"4,516,727.66","417,897","22,142,777",0.44,"10,174.50",0.97%,259.20,"457,813",2.07%,272.00,0.16,,119.10,125500.75,"1,920",0,170,',
    ].join("\n");
    const r3c = await importAdSpendCsv({ ...ctx, provider: "GOOGLE_ADS" }, realGadsDaily);
    ok("imports once the Day column exists", r3c.errors.length === 0, r3c.errors.join("; "));
    ok("two days", r3c.daysImported === 2, `${r3c.daysImported}`);
    // 50,000 + 30,000 on 01 Aug; 45,500.75 on 02 Aug. The Total: Account row
    // restates 125,500.75 and must not be added again.
    ok("campaigns summed per day, Total row excluded", r3c.totalSpendPaise === 12550075n, inr(r3c.totalSpendPaise));

    // --- 4. Date formats --------------------------------------------------
    console.log("\n[4] date formats");
    for (const [label, value, expect] of [
      ["ISO", "2026-08-05", "2026-08-05"],
      ["Mon D, YYYY", '"Aug 5, 2026"', "2026-08-05"],
      ["D Mon YYYY", '"5 Aug 2026"', "2026-08-05"],
      ["DD/MM/YYYY", "05/08/2026", "2026-08-05"],
    ] as const) {
      const r = await importAdSpendCsv(ctx, ["Day,Campaign,Cost", `${value},Brand,500.00`].join("\n"));
      ok(`${label} parses`, r.from === expect, `${r.from} (wanted ${expect})`);
    }

    // --- 5. Multi-account files stay separate ----------------------------
    // The file's own account column wins; without it everything lands under
    // the connection's label. Nothing is asked of the user that the file
    // can answer for itself.
    console.log("\n[5] a file covering two ad accounts");
    const multi = [
      '"Account ID",Day,Campaign,Cost',
      "act_111,2026-09-05,Set A,4000.00",
      "act_222,2026-09-05,Set B,7000.00",
    ].join("\n");
    const r5 = await importAdSpendCsv(ctx, multi);
    ok("both accounts read from the file", r5.accounts.length === 2, JSON.stringify(r5.accounts));
    const sameDay = await prisma.adSpend.count({ where: { connectionId: conn.id, date: new Date("2026-09-05T00:00:00.000Z") } });
    ok("same day, two accounts, kept separate", sameDay === 2, `${sameDay} rows`);

    // --- 6. Junk is refused, not guessed at ------------------------------
    console.log("\n[6] a file that is not an ad report");
    const junk = ["Order Id,Customer,Total", "1001,Asha,499.00"].join("\n");
    const r6 = await importAdSpendCsv(ctx, junk);
    ok("refused", r6.daysImported === 0, `${r6.daysImported} days`);
    ok("names the columns it wanted and what it saw", r6.errors.some((e) => e.includes("Found:")), r6.errors[0] ?? "none");
  } finally {
    await prisma.adSpend.deleteMany({ where: { connectionId: conn.id } });
    await prisma.connection.delete({ where: { id: conn.id } });
  }

  const after = await prisma.adSpend.count({ where: { organizationId: org.id } });
  console.log("\n[7] the demo org is left exactly as it was found");
  ok("no seeded ad-spend rows touched", after === before, `${before} → ${after}`);

  console.log("\n" + "─".repeat(60));
  console.log(`${pass} passed, ${fail} failed`);
  if (failures.length) failures.forEach((f) => console.log(`  ✗ ${f}`));
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
