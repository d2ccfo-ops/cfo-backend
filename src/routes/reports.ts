import { Router } from "express";
import { DEFAULT_TIMEZONE, resolveDateRange, withDateRange } from "../lib/dateRange.js";
import { writeAudit } from "../lib/audit.js";
import { requireAuth } from "../middleware/auth.js";
import { getOrgSettings } from "../modules/orgs/settings.js";
import { DEFAULT_FISCAL_START_MONTH, availablePeriods } from "../modules/reports/fiscal.js";
import { REPORTS, REPORTS_BY_KIND, buildReport, reportToCsv, type ReportKind } from "../modules/reports/reports.js";

// §20.14 transport.

export const reportsRouter = Router();

async function fiscalStart(organizationId: string): Promise<number> {
  const settings = await getOrgSettings(organizationId);
  return settings.fiscalYearStartMonth ?? DEFAULT_FISCAL_START_MONTH;
}

// What exists, and which periods it can be run for. The period list comes from
// the server so a report is named the same way everywhere — "August 2026" and
// "1 Aug to 31 Aug" are different things, and the second is how a figure ends
// up defensible only to whoever ran it.
reportsRouter.get("/", ...requireAuth, async (req, res) => {
  const startMonth = await fiscalStart(req.auth!.organizationId);
  const periods = availablePeriods(new Date(), startMonth, req.auth!.timezone ?? DEFAULT_TIMEZONE);
  res.json({
    reports: REPORTS,
    fiscalYearStartMonth: startMonth,
    periods: periods.map((p) => ({
      key: p.key,
      label: p.label,
      from: p.from.toISOString().slice(0, 10),
      to: p.to.toISOString().slice(0, 10),
    })),
  });
});

reportsRouter.get("/:kind", ...requireAuth, withDateRange, async (req, res) => {
  const kind = req.params.kind as ReportKind;
  const def = REPORTS_BY_KIND.get(kind);
  if (!def) {
    res.status(404).json({
      error: "unknown_report",
      message: `No report named "${kind}". Available: ${REPORTS.map((r) => r.kind).join(", ")}.`,
    });
    return;
  }

  const timeZone = req.auth!.timezone ?? DEFAULT_TIMEZONE;
  const startMonth = await fiscalStart(req.auth!.organizationId);

  // A period KEY ("2026-08", "2026-27-Q3") beats a raw from/to: it is the
  // thing a person files, and resolving it server-side is what stops two
  // people running "the August report" over two different windows.
  const periodKey = typeof req.query.period === "string" ? req.query.period : null;
  const known = availablePeriods(new Date(), startMonth, timeZone, 24);
  const matched = periodKey ? known.find((p) => p.key === periodKey) : null;
  if (periodKey && !matched) {
    res.status(400).json({
      error: "unknown_period",
      message: `No period "${periodKey}". Ask GET /reports for the list, or pass from/to instead.`,
    });
    return;
  }

  const range = matched
    ? resolveDateRange(
        { from: matched.from.toISOString().slice(0, 10), to: matched.to.toISOString().slice(0, 10) },
        new Date(),
        timeZone
      )
    : req.dateRange!;
  const label =
    matched?.label ??
    `${range.from.toISOString().slice(0, 10)} to ${range.to.toISOString().slice(0, 10)}`;

  const report = await buildReport(req.auth!.organizationId, timeZone, kind, range, label);

  if (req.query.format === "csv") {
    // §29: an export is data leaving the system. Who took what, when, and for
    // which period — the question that gets asked after a figure turns up
    // somewhere it should not have.
    await writeAudit({
      organizationId: req.auth!.organizationId,
      actorType: "USER",
      actorId: req.auth!.userId,
      action: "report.exported",
      entityType: "REPORT",
      entityId: kind,
      metadata: { period: label, rows: report.rows.length, format: "csv" },
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${kind}-${(matched?.key ?? range.from.toISOString().slice(0, 10)).replace(/[^a-zA-Z0-9-]/g, "")}.csv"`
    );
    res.send(reportToCsv(report));
    return;
  }

  res.json(report);
});
