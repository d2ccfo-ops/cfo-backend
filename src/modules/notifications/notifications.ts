import type { NotificationSeverity, NotificationType } from "@prisma/client";
import { DEFAULT_TIMEZONE, zonedDayKey } from "../../lib/dateRange.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { getAvailableCashSummary } from "../calc/cash.js";
import { getDataFreshness } from "../calc/freshness.js";
import { formatInr } from "../calc/money.js";
import { getPayablesSummary } from "../calc/payables.js";
import { readReconciliationLegs } from "../calc/reconciliation.js";
import { getOrgSettings } from "../orgs/settings.js";

// §23 (P3.1). "Anomalies nobody sees are worthless."
//
// The §17 engine has run nightly since P2.1c and finds real problems. Every
// one of them waits for someone to open the Exceptions page and notice. This
// module is what turns a finding into something that reaches a person.
//
// Everything here is POLLED, not evented, and that is deliberate. An evented
// design ("emit when the anomaly is created") misses every condition that is a
// STATE rather than an event — cash has been below threshold for three weeks,
// a connection has been failing since Tuesday — and those are exactly the ones
// worth being told about. Polling re-evaluates the world nightly and lets the
// dedupe key collapse a persistent condition into one row.
//
// Which makes the dedupe key the load-bearing part. Without it a founder whose
// cash sat below threshold for three weeks would find twenty-one identical
// notifications. The key names the CONDITION, not the moment: while it holds,
// the row is updated in place and stays unread if it was unread.
//
// No BullMQ import here, for the reason syncCadence.ts documents and that has
// already cost this project a debugging session — the scheduler builds a Queue
// at module scope, and importing it opens a Redis connection that never
// closes. The sweep lives here so a script can run it and terminate.

export const NOTIFICATION_VERSION = "v1";

/** How overdue-ness is judged for a payables warning. */
const VENDOR_DUE_LOOKAHEAD_DAYS = 7;
/** Above this share of a leg's rows needing review, the leg is in trouble. */
const RECON_EXCEPTION_PCT = 15;
/** And below this many rows, a percentage is noise rather than a signal. */
const RECON_MIN_ROWS = 20;

export interface NotificationCandidate {
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body: string;
  resourceType?: string;
  resourceId?: string;
  dedupeKey: string;
}

/**
 * Write a candidate, collapsing a persistent condition onto one row.
 *
 * The update branch deliberately does NOT touch readAt. A founder who has read
 * "cash is below ₹5,00,000" should not have it march back to unread every
 * night while the condition persists — that trains people to ignore the bell,
 * which is the one failure a notification system cannot recover from. The row
 * resurfaces only when the condition CLEARS and later returns, because the
 * dedupe key changes with the thing it names.
 */
export async function emitNotification(organizationId: string, c: NotificationCandidate): Promise<"created" | "updated"> {
  const existing = await prisma.notification.findUnique({ where: { dedupeKey: c.dedupeKey }, select: { id: true } });
  if (existing) {
    await prisma.notification.update({
      where: { id: existing.id },
      data: { severity: c.severity, title: c.title, body: c.body, resourceType: c.resourceType, resourceId: c.resourceId },
    });
    return "updated";
  }
  await prisma.notification.create({
    data: {
      organizationId,
      type: c.type,
      severity: c.severity,
      title: c.title,
      body: c.body,
      resourceType: c.resourceType,
      resourceId: c.resourceId,
      dedupeKey: c.dedupeKey,
    },
  });
  return "created";
}

// ---------------------------------------------------------------------------
// The rules. Each is a pure function of an already-computed summary — the same
// shape modules/calc/anomalies.ts uses, and for the same reason: a rule that
// needs a database to test is a rule nobody tests.
// ---------------------------------------------------------------------------

export function decideAnomalyNotifications(
  organizationId: string,
  anomalies: Array<{ id: string; type: string; severity: NotificationSeverity; recommendedInvestigation: string }>
): NotificationCandidate[] {
  // Only CRITICAL anomalies notify. WARNING and INFO belong on the Exceptions
  // page, where someone goes to look; promoting all of them would put a dozen
  // rows in the bell every night and the one that mattered would be lost among
  // them. The threshold is what makes the bell worth opening.
  return anomalies
    .filter((a) => a.severity === "CRITICAL")
    .map((a) => ({
      type: "ANOMALY_CREATED" as const,
      severity: "CRITICAL" as const,
      title: `Critical: ${a.type.toLowerCase().replaceAll("_", " ")}`,
      body: a.recommendedInvestigation,
      resourceType: "ANOMALY",
      resourceId: a.id,
      // Keyed to the anomaly, so re-running the sweep over an anomaly that is
      // still open does not re-notify.
      dedupeKey: `notif:anomaly:${organizationId}:${a.id}`,
    }));
}

export function decideSyncFailureNotifications(
  organizationId: string,
  sources: Array<{ connectionId: string; provider: string; status: string; lastSyncError: string | null; fresh: boolean; ageMinutes: number | null }>
): NotificationCandidate[] {
  const out: NotificationCandidate[] = [];
  for (const s of sources) {
    if (s.status !== "ACTIVE") continue;

    if (s.lastSyncError) {
      out.push({
        type: "SYNC_FAILED",
        severity: "CRITICAL",
        title: `${s.provider} sync is failing`,
        // The provider's own error, not a paraphrase. "Something went wrong"
        // is unactionable; "401 Unauthorized" tells a founder to reconnect.
        body: `${s.provider} last reported: ${s.lastSyncError}. Every figure built on this source is frozen at its last successful sync until it is reconnected.`,
        resourceType: "CONNECTION",
        resourceId: s.connectionId,
        dedupeKey: `notif:sync_failed:${organizationId}:${s.connectionId}`,
      });
      continue;
    }

    // Stale but not errored is its own case: nothing threw, the job simply is
    // not running. It reads as healthy from every screen in the product, which
    // is precisely why it needs saying.
    if (!s.fresh) {
      const age = s.ageMinutes === null ? "never" : `${Math.floor(s.ageMinutes / 60)}h ago`;
      out.push({
        type: "DATA_STALE",
        severity: "WARNING",
        title: `${s.provider} data is stale`,
        body:
          s.ageMinutes === null
            ? `${s.provider} is connected but has never completed a sync, so it is contributing nothing to any figure on the dashboard.`
            : `${s.provider} last synced ${age}. Numbers derived from it describe the business as it was then, not as it is now.`,
        resourceType: "CONNECTION",
        resourceId: s.connectionId,
        dedupeKey: `notif:stale:${organizationId}:${s.connectionId}`,
      });
    }
  }
  return out;
}

export function decideCashThresholdNotification(
  organizationId: string,
  availableCashMinor: bigint,
  thresholdPaise: string | null | undefined,
  hasBank: boolean
): NotificationCandidate[] {
  // No threshold configured is not a reason to invent one. A default would
  // either fire for every organisation on day one or never fire at all, and
  // either way it would be a number nobody chose.
  if (!thresholdPaise || !hasBank) return [];
  const threshold = BigInt(thresholdPaise);
  if (availableCashMinor >= threshold) return [];
  return [
    {
      type: "CASH_BELOW_THRESHOLD",
      severity: "CRITICAL",
      title: "Cash is below your threshold",
      body: `Available cash is ${formatInr(availableCashMinor)}, against the ${formatInr(threshold)} threshold set for this organisation.`,
      resourceType: "METRIC",
      resourceId: "available_cash",
      // Keyed to the CONDITION, not the amount: re-keying on the balance would
      // create a new row every time a single transaction moved it by a rupee.
      dedupeKey: `notif:cash_below:${organizationId}`,
    },
  ];
}

export function decideVendorPaymentNotification(
  organizationId: string,
  payables: { dueNext7Minor: string; dueNext7Count: number; overdueMinor: string; overdueCount: number },
  dayKey: string
): NotificationCandidate[] {
  const out: NotificationCandidate[] = [];
  const overdue = BigInt(payables.overdueMinor);
  if (payables.overdueCount > 0 && overdue > 0n) {
    out.push({
      type: "VENDOR_PAYMENT_DUE",
      severity: "WARNING",
      title: `${payables.overdueCount} vendor bill${payables.overdueCount === 1 ? " is" : "s are"} overdue`,
      body: `${formatInr(overdue)} is past its due date.`,
      resourceType: "PAGE",
      resourceId: "payables",
      // Re-keyed per day for this one, unlike the cash threshold: which bills
      // are overdue genuinely changes day to day, and a founder who cleared
      // yesterday's should see today's rather than a row they already read.
      dedupeKey: `notif:payables_overdue:${organizationId}:${dayKey}`,
    });
  }
  const dueSoon = BigInt(payables.dueNext7Minor);
  if (payables.dueNext7Count > 0 && dueSoon > 0n) {
    out.push({
      type: "VENDOR_PAYMENT_DUE",
      severity: "INFO",
      title: `${formatInr(dueSoon)} due in the next ${VENDOR_DUE_LOOKAHEAD_DAYS} days`,
      body: `${payables.dueNext7Count} vendor bill${payables.dueNext7Count === 1 ? "" : "s"} fall due this week.`,
      resourceType: "PAGE",
      resourceId: "payables",
      dedupeKey: `notif:payables_due:${organizationId}:${dayKey}`,
    });
  }
  return out;
}

export function decideReconExceptionNotification(
  organizationId: string,
  legs: Array<{ matchType: string; state: string; eligible: number; needsReview: number }>,
  dayKey: string
): NotificationCandidate[] {
  const out: NotificationCandidate[] = [];
  for (const leg of legs) {
    if (leg.state !== "ran") continue;
    // A percentage over a handful of rows is noise. Three of five needing
    // review is 60% and means nothing; three hundred of two thousand is a
    // process that has broken.
    if (leg.eligible < RECON_MIN_ROWS) continue;
    const pct = Math.round((leg.needsReview / leg.eligible) * 1000) / 10;
    if (pct < RECON_EXCEPTION_PCT) continue;
    out.push({
      type: "RECON_EXCEPTION_SPIKE",
      severity: pct >= 40 ? "CRITICAL" : "WARNING",
      title: `${pct}% of ${leg.matchType.toLowerCase().replaceAll("_", " ")} matches need review`,
      body: `${leg.needsReview} of ${leg.eligible} rows differ by more than the ₹1 tolerance. That is usually a fee or a rate that changed, not a one-off.`,
      resourceType: "PAGE",
      resourceId: "reconciliation",
      dedupeKey: `notif:recon_spike:${organizationId}:${leg.matchType}:${dayKey}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gather + sweep
// ---------------------------------------------------------------------------

export interface NotificationRunResult {
  organizationId: string;
  created: number;
  updated: number;
  candidates: number;
}

export async function runNotificationRules(organizationId: string, now: Date = new Date()): Promise<NotificationRunResult> {
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { timezone: true } });
  const timeZone = org?.timezone ?? DEFAULT_TIMEZONE;
  const dayKey = zonedDayKey(now, timeZone);

  const [openAnomalies, freshness, cash, settings, payables, legs] = await Promise.all([
    prisma.anomaly.findMany({
      where: { organizationId, status: "OPEN" },
      select: { id: true, type: true, severity: true, recommendedInvestigation: true },
    }),
    getDataFreshness(organizationId),
    getAvailableCashSummary(organizationId),
    getOrgSettings(organizationId),
    getPayablesSummary(organizationId),
    readReconciliationLegs(organizationId),
  ]);

  const hasBank = cash.connections.length > 0 || cash.missingOpeningBalance.length > 0;

  const candidates: NotificationCandidate[] = [
    ...decideAnomalyNotifications(
      organizationId,
      openAnomalies.map((a) => ({ ...a, severity: a.severity as NotificationSeverity }))
    ),
    ...decideSyncFailureNotifications(organizationId, freshness.sources),
    ...decideCashThresholdNotification(organizationId, BigInt(cash.valueMinor), settings.cashThresholdPaise, hasBank),
    ...decideVendorPaymentNotification(organizationId, payables, dayKey),
    ...decideReconExceptionNotification(organizationId, legs, dayKey),
  ];

  let created = 0;
  let updated = 0;
  for (const c of candidates) {
    const outcome = await emitNotification(organizationId, c);
    if (outcome === "created") created += 1;
    else updated += 1;
  }

  return { organizationId, created, updated, candidates: candidates.length };
}

export interface NotificationSweepResult {
  organizations: number;
  ran: number;
  failed: number;
  created: number;
  updated: number;
}

export async function runNotificationSweep(now: Date = new Date()): Promise<NotificationSweepResult> {
  const organizations = await prisma.organization.findMany({ select: { id: true } });
  const result: NotificationSweepResult = { organizations: organizations.length, ran: 0, failed: 0, created: 0, updated: 0 };

  for (const org of organizations) {
    try {
      const run = await runNotificationRules(org.id, now);
      result.ran += 1;
      result.created += run.created;
      result.updated += run.updated;
    } catch (err) {
      // One organisation's failure must not abandon the rest — the same rule
      // the anomaly and snapshot sweeps hold to.
      result.failed += 1;
      logger.error({ err, organizationId: org.id }, "notification_sweep_org_failed");
    }
  }
  return result;
}
