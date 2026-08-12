import type { Provider } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { rupeesToPaise } from "../../calc/money.js";

// Ad-spend CSV import, for Meta Ads Manager and Google Ads exports.
//
// WHY THIS EXISTS ALONGSIDE THE API CONNECTORS
// --------------------------------------------
// The Meta and Google connectors poll `time_increment=1` insights and are the
// right long-term path. But both need an OAuth app that has cleared review, and
// a founder who has not finished that has no way to get ad spend in at all —
// while sitting on an export they can download in ten seconds. This closes that
// gap. It writes the SAME AdSpend rows the API connectors write, so the
// Expenses page cannot tell the difference and neither can any calc.
//
// THE REFUSAL THAT MATTERS
// ------------------------
// Meta's default export is aggregated over the whole reporting window: every
// row says "2025-12-10 → 2026-08-10" and states one number for those 244 days.
// AdSpend is keyed per DAY, and a CFO dashboard's entire job here is showing
// spend over time — so importing that would either collapse 8 months onto a
// single date or spread a guess across 244 of them. Both are fabrications.
//
// So an aggregate export is REFUSED with instructions for re-exporting.
//
// Detection is by the presence of a DEDICATED day column, not by comparing the
// range columns — which was the first attempt and was wrong. Meta's
// day-broken-down export keeps "Reporting starts"/"Reporting ends" as the
// report's OVERALL range and adds "Day" beside it, so a starts-vs-ends
// comparison rejected exactly the file this importer tells people to produce.
// Once a real day column exists the range columns describe the report, not the
// row, and are ignored.
//
// THE OTHER TRAP
// --------------
// Meta puts an ACCOUNT TOTAL row at the top with a blank ad set name. Measured
// against a real export it equalled the sum of all 67 ad sets to the paisa —
// importing it would have doubled reported spend. Rows with no campaign/ad set
// name are skipped for exactly that reason.

export interface AdSpendImportResult {
  provider: Provider;
  /** Days written (one AdSpend row per day — ad sets on a day are summed). */
  daysImported: number;
  rowsRead: number;
  rowsSkipped: number;
  totalSpendPaise: bigint;
  from: string | null;
  to: string | null;
  /** Ad accounts seen — from the file where it states one, else the connection's. */
  accounts: string[];
  errors: string[];
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

function findCol(headers: string[], candidates: string[]): number {
  const n = headers.map(norm);
  for (const c of candidates) {
    const i = n.indexOf(norm(c));
    if (i >= 0) return i;
  }
  return -1;
}

// Meta writes "Amount spent (INR)" — the currency is IN THE HEADER, not a
// column — so the header is where it has to be read from.
function currencyFromHeaders(headers: string[]): string {
  for (const h of headers) {
    const m = h.match(/\(([A-Z]{3})\)/);
    if (m) return m[1]!;
  }
  return "INR";
}

function parseNumber(raw: string | undefined): number | null {
  if (raw == null) return null;
  const c = raw.replace(/[₹$,\s]/g, "").trim();
  if (c === "" || c === "-" || c === "--") return null;
  const n = Number(c);
  return Number.isNaN(n) ? null : n;
}

// Exports use ISO or DD/MM/YYYY. Returns the UTC-midnight key AdSpend stores.
function parseDay(raw: string | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) {
    const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // "Aug 1, 2026" / "1 Aug 2026" — Google Ads emits these under some locales.
  const MONTHS: Record<string, number> = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  const t = s.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/) ?? null;
  if (t) {
    const mo = MONTHS[t[1]!.slice(0, 3).toLowerCase()];
    if (mo !== undefined) return new Date(Date.UTC(Number(t[3]), mo, Number(t[2])));
  }
  const t2 = s.match(/^(\d{1,2})\s+([A-Za-z]{3,}),?\s+(\d{4})$/) ?? null;
  if (t2) {
    const mo = MONTHS[t2[2]!.slice(0, 3).toLowerCase()];
    if (mo !== undefined) return new Date(Date.UTC(Number(t2[3]), mo, Number(t2[1])));
  }
  return null;
}

// Meta and Google both CAN include the account in the export, depending on
// which columns were selected. When they do, it is read from the file — the
// file is authoritative and a hand-typed id is not verifiable against it.
const ACCOUNT_COLS = ["Account ID", "Account Id", "Account name", "Customer ID", "Account"];
const DEDICATED_DAY_COLS = ["Day", "Date"];
const DAY_COLS = ["Day", "Date", "Reporting starts"];
const END_COLS = ["Reporting ends"];
const NAME_COLS = ["Ad set name", "Campaign name", "Campaign", "Ad name", "Ad group", "Ad group name"];
const SPEND_COLS = ["Amount spent (INR)", "Amount spent", "Cost", "Spend", "Amount spent (USD)"];
const IMPR_COLS = ["Impressions", "Impr.", "Impr"];
const CLICK_COLS = ["Link clicks", "Clicks (all)", "Clicks", "Clicks (link)"];

export interface AdSpendImportContext {
  connectionId: string;
  organizationId: string;
  legalEntityId: string;
  externalAccountId: string;
  provider: Provider;
}

export async function importAdSpendCsv(ctx: AdSpendImportContext, csv: string): Promise<AdSpendImportResult> {
  const result: AdSpendImportResult = {
    provider: ctx.provider,
    daysImported: 0,
    rowsRead: 0,
    rowsSkipped: 0,
    totalSpendPaise: 0n,
    from: null,
    to: null,
    accounts: [],
    errors: [],
  };

  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) {
    result.errors.push("file has no data rows");
    return result;
  }

  // FIND THE HEADER ROW, don't assume it is the first line.
  //
  // Google Ads exports open with title and date-range rows — a real file starts
  // "Campaign report" on line 1 and does not reach the column names until line
  // 3. Taking line 1 produced `could not find a date column … Found: Campaign
  // report`, which is accurate and useless.
  //
  // The header is identified by what it CONTAINS rather than by position: the
  // first row within the opening few that resolves both a date and a spend
  // column. Anything above it is preamble and is discarded.
  // Two passes, and the second one matters: requiring BOTH a date and a spend
  // column meant an export with no date column at all never located its header,
  // fell back to line 1, and reported `Found: Campaign report` — which hid the
  // actual problem (a missing Day segment) behind a nonsense header listing.
  // The spend column alone identifies the header; whether a date column exists
  // is a separate question, answered below with a message that can be acted on.
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 15); i += 1) {
    const c = parseCsvLine(lines[i]!);
    if (findCol(c, DAY_COLS) >= 0 && findCol(c, SPEND_COLS) >= 0) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) {
    for (let i = 0; i < Math.min(lines.length, 15); i += 1) {
      const c = parseCsvLine(lines[i]!);
      if (findCol(c, SPEND_COLS) >= 0 && c.length >= 3) {
        headerIdx = i;
        break;
      }
    }
  }
  if (headerIdx < 0) headerIdx = 0;
  const headers = parseCsvLine(lines[headerIdx]!);
  // Google writes the reporting period on its own line above the header
  // ("All time", "Aug 1, 2026 - Aug 3, 2026"). Worth quoting back, because it
  // is the clearest evidence of what was actually exported.
  const periodNote = headerIdx > 0 ? (lines[headerIdx - 1] ?? "").replace(/^"|"$/g, "").trim() : "";
  // A DEDICATED day column ("Day"/"Date") is what Meta adds once you set
  // Breakdown → By Time → Day, and Google adds with the Day segment.
  const iDedicatedDay = findCol(headers, DEDICATED_DAY_COLS);
  const iDay = iDedicatedDay >= 0 ? iDedicatedDay : findCol(headers, DAY_COLS);
  // The aggregate check ONLY applies when the date came from "Reporting starts".
  //
  // A correctly broken-down Meta export keeps "Reporting starts"/"Reporting
  // ends" as the OVERALL range and adds "Day" alongside it — so comparing the
  // row's day against "Reporting ends" would reject the very file this
  // importer asks people to produce. Once a real day column exists, the range
  // columns are metadata about the report, not about the row.
  const iEnd = iDedicatedDay >= 0 ? -1 : findCol(headers, END_COLS);
  const iName = findCol(headers, NAME_COLS);
  const iSpend = findCol(headers, SPEND_COLS);
  const iImpr = findCol(headers, IMPR_COLS);
  const iClick = findCol(headers, CLICK_COLS);
  const iAccount = findCol(headers, ACCOUNT_COLS);
  const currency = currencyFromHeaders(headers);

  if (iDay < 0) {
    // The spend column being present tells us this IS an ad report — just one
    // exported without a per-day breakdown. That is a different problem from
    // "wrong file", and saying so is the difference between a fix that takes
    // thirty seconds and one that takes an afternoon.
    const looksLikeAdReport = findCol(headers, SPEND_COLS) >= 0;
    if (looksLikeAdReport) {
      result.errors.push(
        `This report has no per-day column${periodNote ? ` — it covers "${periodNote}"` : ""}, so every row is one ` +
          `total for the whole period and carries no daily figures. Add the day breakdown and export again: in Google Ads ` +
          `open the report, click the segment icon (or Segment → Time → Day) so a "Day" column appears, then Download → ` +
          `.csv. In Meta Ads Manager use Breakdown → By Time → Day before exporting. Nothing was imported.`
      );
    } else {
      result.errors.push(
        `could not find a date column. Expected one of: ${DAY_COLS.join(", ")}. Found: ${headers.join(", ")}`
      );
    }
    return result;
  }
  if (iSpend < 0) {
    result.errors.push(
      `could not find a spend column. Expected one of: ${SPEND_COLS.join(", ")}. Found: ${headers.join(", ")}`
    );
    return result;
  }

  // Sum per (account, day): AdSpend is unique on (connection, account, date),
  // and an export broken down by ad set has many rows per day. Account is
  // keyed too so a file covering several ad accounts does not have one
  // account's spend silently overwrite another's on the same date.
  const byDay = new Map<
    string,
    { date: Date; account: string; spend: number; impressions: number; clicks: number; rows: number }
  >();

  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const f = parseCsvLine(lines[i]!);
    result.rowsRead += 1;

    // Summary rows. Meta writes an account TOTAL with a blank name; Google
    // closes the file with "Total: account" / "Total: campaigns". Both restate
    // money already present on the detail rows, so importing either doubles it.
    const rowName = iName >= 0 ? (f[iName] ?? "").trim() : "";
    if (iName >= 0 && (!rowName || /^total\b/i.test(rowName))) {
      result.rowsSkipped += 1;
      continue;
    }

    const day = parseDay(f[iDay]);
    if (!day) {
      result.rowsSkipped += 1;
      continue;
    }

    // THE AGGREGATE CHECK. A row covering a span is not a day's spend.
    if (iEnd >= 0) {
      const end = parseDay(f[iEnd]);
      if (end && end.getTime() !== day.getTime()) {
        const days = Math.round((end.getTime() - day.getTime()) / 86_400_000) + 1;
        result.errors.push(
          `This export is aggregated over ${days} days (${f[iDay]} to ${f[iEnd]}), so it carries no daily figures — ` +
            `every row states one total for the whole period. Re-export it broken down by day: in Meta Ads Manager use ` +
            `Reports → Export, and set Breakdown → Time → Day (in Google Ads, add the "Day" segment). Nothing was imported.`
        );
        return result;
      }
    }

    const spend = parseNumber(f[iSpend]);
    if (spend === null) {
      result.rowsSkipped += 1;
      continue;
    }

    // The file's own account wins; otherwise everything lands under the
    // connection's label. Nothing is asked of the user that the file can answer.
    const account = (iAccount >= 0 ? (f[iAccount] ?? "").trim() : "") || ctx.externalAccountId;
    const key = `${account}\u0000${day.toISOString().slice(0, 10)}`;
    const acc = byDay.get(key) ?? { date: day, account, spend: 0, impressions: 0, clicks: 0, rows: 0 };
    acc.spend += spend;
    acc.impressions += iImpr >= 0 ? (parseNumber(f[iImpr]) ?? 0) : 0;
    acc.clicks += iClick >= 0 ? (parseNumber(f[iClick]) ?? 0) : 0;
    acc.rows += 1;
    byDay.set(key, acc);
  }

  if (byDay.size === 0) {
    if (result.errors.length === 0) result.errors.push("no usable rows — every row was missing a date or a spend figure");
    return result;
  }

  const days = [...byDay.values()].map((v) => v.date.toISOString().slice(0, 10)).sort();
  result.from = days[0]!;
  result.to = days[days.length - 1]!;
  result.accounts = [...new Set([...byDay.values()].map((v) => v.account))];

  for (const [, v] of byDay) {
    const spendAmount = rupeesToPaise(v.spend);
    await prisma.adSpend.upsert({
      where: {
        connectionId_externalAccountId_date: {
          connectionId: ctx.connectionId,
          externalAccountId: v.account,
          date: v.date,
        },
      },
      create: {
        organizationId: ctx.organizationId,
        legalEntityId: ctx.legalEntityId,
        connectionId: ctx.connectionId,
        provider: ctx.provider,
        externalAccountId: v.account,
        date: v.date,
        spendAmount,
        currency,
        impressions: v.impressions || null,
        clicks: v.clicks || null,
        raw: { source: "csv_import", rowsOnThisDay: v.rows } as object,
      },
      update: {
        spendAmount,
        currency,
        impressions: v.impressions || null,
        clicks: v.clicks || null,
        raw: { source: "csv_import", rowsOnThisDay: v.rows } as object,
      },
    });
    result.daysImported += 1;
    result.totalSpendPaise += spendAmount;
  }

  return result;
}
