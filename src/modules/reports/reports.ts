import type { ResolvedRange } from "../../lib/dateRange.js";
import { prisma } from "../../lib/prisma.js";
import { getContributionMargin } from "../calc/contribution.js";
import { getCostCoverage } from "../calc/cogs.js";
import { getDataStatusMap } from "../calc/dataStatus.js";
import { paiseToRupees } from "../calc/money.js";
import { getSettlementSummary } from "../calc/moneyMovement.js";
import { readReconciliationLegs } from "../calc/reconciliation.js";
import { getRevenueLadder } from "../calc/revenueLadder.js";
import { escapeCsvCell } from "../../lib/csv.js";

// §20.14 reports (P5.3).
//
// The Reports page previously listed six reports, each stamped "Updated 1 hour
// ago" beside a live-looking Export button, plus three scheduled sends to
// real-looking addresses ("ca@sharmaassociates.in", next send 1 Sep 2026). No
// endpoint existed. A founder would reasonably have believed their CA was
// receiving a monthly P&L; nothing was being sent, ever.
//
// What is built here is deliberately the four reports that can be produced
// HONESTLY from data this system actually holds. A balance sheet and a real
// P&L need an accounting feed (§7 puts them out of V1), and shipping a
// half-derived one under those names is how a founder files something wrong.
//
// EVERY REPORT CARRIES ITS OWN HONESTY LABEL. A CSV that leaves this system
// and lands in someone's inbox has no dashboard around it explaining that
// margin is estimated — so the label travels IN the file, as rows, not as a
// footnote a spreadsheet drops on import.

export const REPORTS_VERSION = "v1";

export type ReportKind = "margin-summary" | "settlement-report" | "reconciliation-report" | "cost-coverage";

export interface ReportDefinition {
  kind: ReportKind;
  title: string;
  description: string;
  /** What a reader must know before acting on it. Never empty. */
  caveat: string;
  periodScoped: boolean;
}

export const REPORTS: ReportDefinition[] = [
  {
    kind: "margin-summary",
    title: "Margin summary",
    description: "The §11 revenue ladder and the §36 contribution-margin layers for a period, with the cost coverage behind each layer.",
    caveat:
      "This is not a profit and loss statement. It covers cost layers this system can see — COGS, fulfilment, fees, ads — and no operating costs. Payroll, rent and tax never touch a Shopify order.",
    periodScoped: true,
  },
  {
    kind: "settlement-report",
    title: "Settlement report",
    description: "Every provider payout that landed in the period, with fees, GST on fees and the UTR to trace it in the bank statement.",
    caveat:
      "A payout with no UTR cannot be matched to a bank credit. Those rows are included and flagged rather than dropped, because a report that quietly omits them understates what is unreconciled.",
    periodScoped: true,
  },
  {
    kind: "reconciliation-report",
    title: "Reconciliation report",
    description: "The state of each §15 leg: how much is matched, how much needs review, and which legs cannot run at all.",
    caveat:
      "A leg that cannot run is reported as unavailable with its reason, never as zero exceptions. The two look identical on a summary line and mean opposite things.",
    periodScoped: false,
  },
  {
    kind: "cost-coverage",
    title: "Cost coverage",
    description: "Which SKUs have a real cost, which are estimated, and which have none — the input every margin figure depends on.",
    caveat:
      "Read this before the margin summary. A margin computed over 4% cost coverage is arithmetic, not a measurement.",
    periodScoped: false,
  },
];

export const REPORTS_BY_KIND = new Map(REPORTS.map((r) => [r.kind, r]));

export interface ReportResult {
  kind: ReportKind;
  title: string;
  period: { from: string; to: string; label: string } | null;
  generatedAt: string;
  /** §28 honesty label for whatever this report leans on. */
  dataStatus: unknown;
  formulaVersion: string;
  caveat: string;
  rows: Array<Record<string, string | number | null>>;
  /** Anything that makes the numbers less trustworthy than they look. */
  warnings: string[];
}

const R = (paise: bigint | null | undefined): number | null =>
  paise === null || paise === undefined ? null : paiseToRupees(paise);

export async function buildReport(
  organizationId: string,
  timeZone: string,
  kind: ReportKind,
  range: ResolvedRange,
  periodLabel: string
): Promise<ReportResult> {
  const def = REPORTS_BY_KIND.get(kind)!;
  const statuses = await getDataStatusMap(organizationId);
  const base = {
    kind,
    title: def.title,
    period: def.periodScoped ? { from: range.from.toISOString(), to: range.to.toISOString(), label: periodLabel } : null,
    generatedAt: new Date().toISOString(),
    caveat: def.caveat,
  };

  switch (kind) {
    case "margin-summary": {
      const [ladder, cm, coverage] = await Promise.all([
        getRevenueLadder(organizationId, range),
        getContributionMargin(organizationId, range),
        getCostCoverage(organizationId),
      ]);
      const rows: ReportResult["rows"] = [];
      // Each rung carries the spec section that defines it, so a reader can
      // check the definition rather than infer it from the label.
      for (const [key, rung] of Object.entries(ladder.ladder)) {
        const r = rung as { valueMinor: string; changePct?: number | null; spec?: string };
        rows.push({
          section: "Revenue ladder",
          line: key,
          spec: r.spec ?? null,
          amountRupees: R(BigInt(r.valueMinor)),
          changePct: r.changePct ?? null,
        });
      }
      for (const [key, layer] of Object.entries(cm.levels)) {
        const l = layer as { label: string; includes: string; valueMinor: string; marginPct: number | null; reliable: boolean };
        rows.push({
          section: "Contribution margin",
          line: l.label,
          spec: key.toUpperCase(),
          amountRupees: R(BigInt(l.valueMinor)),
          marginPct: l.marginPct,
          changePct: null,
          // The flag that stops a layer being read as measured when a cost
          // beneath it is missing. Spelled out, because "false" in a
          // spreadsheet cell explains nothing to whoever opens it.
          reliable: l.reliable ? "yes" : "no — a cost layer beneath this is incomplete",
          includes: l.includes,
        });
      }
      const warnings = [...(cm.warnings ?? []), ...(ladder.warnings ?? [])];
      if (coverage.lineCoveragePct < 50) {
        warnings.push(
          `Only ${coverage.lineCoveragePct}% of order lines have a product cost. Every margin figure in this report inherits that gap — see the cost-coverage report.`
        );
      }
      return { ...base, dataStatus: statuses.contribution_margin, formulaVersion: cm.formulaVersion ?? REPORTS_VERSION, rows, warnings };
    }

    case "settlement-report": {
      const [summary, payouts] = await Promise.all([
        getSettlementSummary(organizationId, range),
        prisma.settlement.findMany({
          where: { organizationId, settledAt: { gte: range.from, lte: range.to } },
          orderBy: [{ settledAt: "desc" }],
          select: {
            externalSettlementId: true, utr: true, settledAt: true, amount: true,
            feeAmount: true, taxAmount: true, status: true, provider: true, kind: true,
            _count: { select: { lines: true } },
          },
          take: 5000,
        }),
      ]);
      const rows = payouts.map((p) => ({
        settledAt: p.settledAt?.toISOString().slice(0, 10) ?? null,
        provider: p.provider,
        kind: p.kind,
        externalSettlementId: p.externalSettlementId,
        // Named explicitly rather than left blank: a blank cell reads as a
        // formatting problem, and this one is a reconciliation gap.
        utr: p.utr ?? "(none — cannot be matched to a bank credit)",
        netSettledRupees: R(p.amount),
        feeRupees: R(p.feeAmount),
        gstOnFeeRupees: R(p.taxAmount),
        lineItems: p._count.lines,
        status: p.status,
      }));
      const warnings: string[] = [];
      if (summary.withoutUtrCount > 0)
        warnings.push(`${summary.withoutUtrCount} payout(s) carry no UTR and cannot be traced to a bank credit.`);
      if (summary.undatedCount > 0)
        warnings.push(`${summary.undatedCount} payout(s) have no settlement date at all and fall outside every period, including this one.`);
      if (payouts.length >= 5000) warnings.push("Truncated at 5,000 payouts.");
      return { ...base, dataStatus: statuses.cash_received, formulaVersion: REPORTS_VERSION, rows, warnings };
    }

    case "reconciliation-report": {
      const legs = await readReconciliationLegs(organizationId);
      const rows = legs.map((l) => ({
        leg: l.matchType,
        state: l.state,
        eligible: l.eligible,
        matched: l.matched,
        // Matched but with a money difference — neither clean nor unmatched,
        // and collapsing it into either would hide the rows a human must look
        // at.
        needsReview: l.needsReview,
        unmatched: l.unmatched,
        matchedRupees: R(l.matchedValue),
        unmatchedRupees: R(l.unmatchedValue),
        // The distinction the whole report exists to preserve.
        whyUnavailable: l.state === "unavailable" ? (l.blockedReason ?? "no reason recorded") : null,
      }));
      const blocked = legs.filter((l) => l.state === "unavailable");
      const warnings = blocked.map(
        (l) => `The ${l.matchType} leg could not run: ${l.blockedReason ?? "no reason recorded"}. Its exceptions are unknown, not zero.`
      );
      return { ...base, dataStatus: statuses.revenue, formulaVersion: REPORTS_VERSION, rows, warnings };
    }

    case "cost-coverage": {
      const coverage = await getCostCoverage(organizationId);
      const rows: ReportResult["rows"] = [
        { measure: "Order lines with a product cost", count: coverage.costedLines, pct: coverage.lineCoveragePct },
        { measure: "Order lines total", count: coverage.totalLines, pct: 100 },
        // Coverage BY VALUE, not just by count. A brand can have 90% of its
        // lines costed and still be missing the cost on its bestseller, and
        // only this row would say so.
        { measure: "Order value covered by a cost", count: null, pct: coverage.valueCoveragePct },
        { measure: "SKUs with a real cost", count: coverage.costedSkuCount, pct: null },
        { measure: "SKUs with an estimated cost", count: coverage.estimatedSkuCount, pct: null },
        { measure: "SKUs with no cost at all", count: coverage.missingSkuCount, pct: null },
        { measure: "Order lines whose SKU cannot be costed", count: coverage.uncostableLineCount, pct: null },
      ];
      const warnings: string[] = [];
      if (coverage.missingSkuCount > 0)
        warnings.push(
          `${coverage.missingSkuCount} SKU(s) have no cost. Orders containing them contribute revenue with no COGS, so margin is overstated by exactly the cost nobody has entered.`
        );
      if (coverage.estimatedSkuCount > 0)
        warnings.push(
          `${coverage.estimatedSkuCount} SKU(s) use an ESTIMATED cost. §42.8 — a margin resting on these is not reconciled, whatever else the report says.`
        );
      return { ...base, dataStatus: statuses.product_profitability, formulaVersion: REPORTS_VERSION, rows, warnings };
    }
  }
}

/**
 * CSV, with the honesty label INSIDE the file.
 *
 * A spreadsheet that leaves this system has no dashboard around it. Whoever
 * opens it has no way to know that margin is estimated, that a leg could not
 * run, or that 96% of SKUs have no cost — unless the file says so. So it does,
 * in a header block above the data, before anyone scrolls.
 */
export function reportToCsv(report: ReportResult): string {
  // Shared with the evidence export — both had an identical copy that quoted
  // correctly and never neutralised a leading formula character. See lib/csv.ts.
  const escape = escapeCsvCell;

  const lines: string[] = [];
  lines.push(`# ${report.title}`);
  if (report.period) lines.push(`# Period,${escape(report.period.label)},${report.period.from.slice(0, 10)},${report.period.to.slice(0, 10)}`);
  lines.push(`# Generated,${report.generatedAt}`);
  lines.push(`# Formula version,${escape(report.formulaVersion)}`);
  const status = report.dataStatus as { status?: string; reason?: string } | null;
  if (status?.status) lines.push(`# Data status,${escape(status.status)},${escape(status.reason ?? "")}`);
  lines.push(`# Caveat,${escape(report.caveat)}`);
  for (const w of report.warnings) lines.push(`# Warning,${escape(w)}`);
  lines.push("");

  if (report.rows.length === 0) {
    lines.push("# No rows for this period.");
    return lines.join("\n");
  }

  // Union of keys across rows, in first-seen order — a report whose rows have
  // different shapes (the margin summary does) must not lose the columns that
  // only appear later.
  const headers: string[] = [];
  for (const row of report.rows) for (const k of Object.keys(row)) if (!headers.includes(k)) headers.push(k);

  lines.push(headers.join(","));
  for (const row of report.rows) lines.push(headers.map((h) => escape(row[h])).join(","));
  return lines.join("\n");
}
