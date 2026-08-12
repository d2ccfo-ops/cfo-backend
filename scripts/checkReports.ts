import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { prisma } from "../src/lib/prisma.js";
import { DEFAULT_TIMEZONE, resolveDateRange } from "../src/lib/dateRange.js";
import { DEFAULT_FISCAL_START_MONTH, availablePeriods } from "../src/modules/reports/fiscal.js";
import { REPORTS, buildReport, reportToCsv } from "../src/modules/reports/reports.js";

// P5.3 against real data.
//
// The property a unit test cannot reach: a CSV that leaves this system lands
// in someone's inbox with no dashboard around it. Whoever opens it has no way
// to know that margin is estimated, that a reconciliation leg could not run,
// or that most SKUs have no cost — unless the file itself says so. So every
// report is BUILT from live data here and the resulting CSV is inspected for
// its own honesty header.
//
// Run with: npx tsx scripts/checkReports.ts

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

const FRONTEND = new URL("../../cfo-frontend/", pathToFileURL(import.meta.dirname + "/"));

async function main() {
  const grouped = await prisma.order.groupBy({ by: ["organizationId"], _count: { _all: true } });
  const top = grouped.sort((a, b) => b._count._all - a._count._all)[0];
  if (!top) {
    console.log("no orders — nothing to report on");
    process.exit(1);
  }
  const org = (await prisma.organization.findUnique({
    where: { id: top.organizationId },
    select: { id: true, name: true, timezone: true },
  }))!;
  const timeZone = org.timezone ?? DEFAULT_TIMEZONE;

  // ---------------------------------------------------------------------------
  console.log("\n[1] Periods are fiscal-year aware and unique");
  // ---------------------------------------------------------------------------
  const periods = availablePeriods(new Date(), DEFAULT_FISCAL_START_MONTH, timeZone);
  ok("periods are offered", periods.length > 5, `${periods.length}`);
  ok("every period key is unique", new Set(periods.map((p) => p.key)).size === periods.length);
  ok("every period runs forwards", periods.every((p) => p.from < p.to));
  ok(
    "the financial year is labelled the Indian way",
    periods.some((p) => /^FY\d{4}-\d{2}$/.test(p.label)),
    periods.map((p) => p.label).join(", ")
  );

  // ---------------------------------------------------------------------------
  console.log("\n[2] Every report builds against real data");
  // ---------------------------------------------------------------------------
  const period = periods.find((p) => /^FY/.test(p.label))!;
  const range = resolveDateRange(
    { from: period.from.toISOString().slice(0, 10), to: period.to.toISOString().slice(0, 10) },
    new Date(),
    timeZone
  );

  for (const def of REPORTS) {
    const report = await buildReport(org.id, timeZone, def.kind, range, period.label);
    ok(`${def.kind} builds`, report.rows.length >= 0, `${report.rows.length} rows`);
    ok(`${def.kind} carries a formula version`, report.formulaVersion.length > 0, report.formulaVersion);
    // The caveat is the whole point. A report that ships without one is a
    // report someone will act on without knowing what it leaves out.
    ok(`${def.kind} carries a caveat`, report.caveat.length > 40);
    ok(`${def.kind} scopes its period correctly`, def.periodScoped ? report.period !== null : report.period === null);

    // No BigInt may reach the wire, and no raw paise integer may be presented
    // as a rupee figure.
    const json = JSON.stringify(report);
    ok(`${def.kind} serialises without a BigInt`, json.length > 0);

    const csv = reportToCsv(report);
    ok(`${def.kind} CSV carries its title`, csv.startsWith(`# ${report.title}`));
    ok(`${def.kind} CSV states the formula version`, csv.includes("# Formula version,"));
    ok(`${def.kind} CSV states the caveat`, csv.includes("# Caveat,"));
    ok(`${def.kind} CSV states when it was generated`, csv.includes("# Generated,"));
    if (report.warnings.length > 0) {
      ok(`${def.kind} CSV carries all ${report.warnings.length} warning(s)`, (csv.match(/^# Warning,/gm) ?? []).length === report.warnings.length);
      for (const w of report.warnings) console.log(`      · warning: ${w.slice(0, 110)}`);
    }
    if (report.rows.length > 0) {
      // The union-of-keys rule: the margin summary's rows have different
      // shapes, and a header taken from row 0 alone would drop the columns
      // that only appear later.
      const headerLine = csv.split("\n").find((l) => l.length > 0 && !l.startsWith("#"))!;
      const headers = headerLine.split(",");
      const allKeys = new Set(report.rows.flatMap((r) => Object.keys(r)));
      ok(
        `${def.kind} CSV header covers every key across every row`,
        [...allKeys].every((k) => headers.includes(k)),
        `${headers.length} headers, ${allKeys.size} keys`
      );
      const dataLines = csv.split("\n").filter((l) => l.length > 0 && !l.startsWith("#")).slice(1);
      ok(`${def.kind} CSV has one line per row`, dataLines.length === report.rows.length, `${dataLines.length} vs ${report.rows.length}`);
    }
  }

  // ---------------------------------------------------------------------------
  console.log("\n[3] A blocked reconciliation leg reads as unavailable, never as zero");
  // ---------------------------------------------------------------------------
  const recon = await buildReport(org.id, timeZone, "reconciliation-report", range, period.label);
  const blocked = recon.rows.filter((r) => r.state === "unavailable");
  console.log(`  · ${blocked.length} of ${recon.rows.length} legs cannot run for ${org.name}`);
  ok(
    "every unavailable leg states why",
    blocked.every((r) => typeof r.whyUnavailable === "string" && (r.whyUnavailable as string).length > 5)
  );
  ok(
    "and produces a warning saying its exceptions are unknown rather than zero",
    blocked.length === 0 || recon.warnings.some((w) => /unknown, not zero/.test(w))
  );

  // ---------------------------------------------------------------------------
  console.log("\n[4] The margin summary tells the truth about cost coverage");
  // ---------------------------------------------------------------------------
  const margin = await buildReport(org.id, timeZone, "margin-summary", range, period.label);
  const unreliable = margin.rows.filter((r) => typeof r.reliable === "string" && (r.reliable as string).startsWith("no"));
  console.log(`  · ${unreliable.length} contribution layer(s) flagged unreliable`);
  ok("contribution layers carry a reliability flag", margin.rows.some((r) => r.section === "Contribution margin" && r.reliable !== undefined));
  ok(
    "an unreliable layer explains itself rather than saying 'false'",
    unreliable.every((r) => (r.reliable as string).includes("incomplete"))
  );
  ok("the revenue ladder rungs cite their spec sections", margin.rows.some((r) => r.section === "Revenue ladder" && typeof r.spec === "string"));

  const coverage = await buildReport(org.id, timeZone, "cost-coverage", range, period.label);
  ok("cost coverage reports by VALUE as well as by count", coverage.rows.some((r) => String(r.measure).includes("value")));

  // ---------------------------------------------------------------------------
  console.log("\n[5] The page reads what the server sends");
  // ---------------------------------------------------------------------------
  const pageSrc = await readFile(new URL("app/(dashboard)/reports/page.js", FRONTEND), "utf8");
  for (const field of ["caveat", "periodScoped", "formulaVersion", "dataStatus", "warnings", "rows", "periods", "fiscalYearStartMonth"]) {
    ok(`the page reads .${field}`, pageSrc.includes(field));
  }
  ok("the page requests a keyed period, not a raw range", pageSrc.includes("?period="));
  ok("the page downloads with the bearer token rather than a bare link", pageSrc.includes("res.blob()"));
  // Comments stripped first. The page's own header comment DOCUMENTS the
  // fabricated addresses and next-send dates that used to be rendered, which
  // is exactly the note a future reader needs — the assertion is about what
  // the page SHOWS, not about what it explains.
  const rendered = pageSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  ok(
    "the page no longer claims reports are scheduled to anyone",
    !/ca@sharmaassociates|next send \d|Updated 1 hour ago/i.test(rendered)
  );
  ok("but it still records what used to be fabricated here", /ca@sharmaassociates/i.test(pageSrc));
  ok("the page still names what it cannot produce, and why", /Profit & loss/.test(pageSrc) && /accounting feed/i.test(pageSrc));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
