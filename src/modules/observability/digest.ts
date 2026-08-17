import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { env } from "../../config/env.js";
import { readHostReport } from "./hostFacts.js";

// ONE MESSAGE A DAY, FOR EVERYTHING THAT IS TRUE BUT NOT URGENT.
//
// The alert evaluator handles the other half: conditions that should interrupt
// someone. The gap it leaves is everything that matters and never crosses a
// threshold — error groups that appeared, syncs that quietly degraded, spend
// that drifted, a backup that ran fine every night and has still never been
// restored. None of those deserve a page and all of them deserve to be seen.
//
// SEVERITY DISCIPLINE IS WHY THIS EXISTS. Without a digest, the only way to
// make an INFO-worthy fact visible is to raise it to WARN, and a WARN that
// fires every day is how a whole alerting system gets muted. The digest is what
// makes it possible to keep the PAGE bar high.
//
// IT REPORTS ABSENCE. "No restore has ever been rehearsed" and "no billing
// export is configured" are the two most useful lines this will ever contain,
// and neither is an event — nothing happens to trigger them. A digest built
// only from events would never mention either.
//
// SENT-ONCE IS TRACKED IN THE DATABASE, not in memory: the worker restarts on
// every deploy, and a digest that re-sends on restart trains people to skim.

const DIGEST_KEY = "digest.lastSentDay";
const DAY_MS = 86_400_000;

/** UTC hour at which the digest is sent. After the 19:30 backup, before the overnight jobs. */
const SEND_HOUR_UTC = 3;

export interface DigestSection {
  heading: string;
  lines: string[];
}

export interface Digest {
  day: string;
  subject: string;
  sections: DigestSection[];
  text: string;
}

/**
 * Two decimals is wrong for the numbers this digest actually carries.
 *
 * Cost per order is fractions of a cent — $1.00 of AI spend over 1,716 orders
 * is $0.00058, and `toFixed(2)` renders that as "$0.00", which reads as free.
 * A unit cost that rounds to zero is exactly the figure somebody would build a
 * pricing decision on. So precision follows magnitude, and the number is never
 * allowed to round down into nothing.
 */
function usd(micro: bigint | number): string {
  const n = (typeof micro === "bigint" ? Number(micro) : micro) / 1_000_000;
  if (n === 0) return "$0";
  const abs = Math.abs(n);
  const decimals = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return `$${n.toFixed(decimals)}`;
}

function pct(n: number | null): string {
  return n === null ? "—" : `${(n * 100).toFixed(2)}%`;
}

/**
 * Build the digest for the last 24 hours.
 *
 * Pure: it reads and returns, and never sends. That split is what makes it
 * testable and what lets the console show a preview of exactly what would be
 * delivered rather than a description of it.
 */
export async function buildDigest(now = new Date()): Promise<Digest> {
  const since = new Date(now.getTime() - DAY_MS);
  const day = now.toISOString().slice(0, 10);
  const sections: DigestSection[] = [];

  // ---- alerts ----
  const [firing, openedToday, resolvedToday] = await Promise.all([
    prisma.alert.findMany({ where: { resolvedAt: null }, orderBy: { severity: "asc" } }),
    prisma.alert.count({ where: { firstSeenAt: { gte: since } } }),
    prisma.alert.count({ where: { resolvedAt: { gte: since } } }),
  ]);
  const pages = firing.filter((a) => a.severity === "PAGE");
  sections.push({
    heading: "Alerts",
    lines: [
      `${firing.length} open (${pages.length} page) · ${openedToday} opened and ${resolvedToday} resolved in 24h`,
      ...firing.slice(0, 8).map((a) => `  [${a.severity}] ${a.title}`),
      ...(firing.length > 8 ? [`  …and ${firing.length - 8} more`] : []),
    ],
  });

  // ---- what the outside saw ----
  const probes = await prisma.syntheticCheck.groupBy({
    by: ["target"],
    where: { at: { gte: since } },
    _count: { _all: true },
    _sum: { ms: true },
  });
  const failed = await prisma.syntheticCheck.groupBy({
    by: ["target"],
    where: { at: { gte: since }, ok: false },
    _count: { _all: true },
  });
  const failMap = new Map(failed.map((f) => [f.target, f._count._all]));
  sections.push({
    heading: "Availability, measured from outside the app",
    lines:
      probes.length === 0
        ? ["No probes recorded. The prober is not running."]
        : probes.map((p) => {
            const bad = failMap.get(p.target) ?? 0;
            const total = p._count._all;
            const up = total === 0 ? null : (total - bad) / total;
            const mean = total === 0 ? null : Math.round((p._sum.ms ?? 0) / total);
            return `  ${p.target}: ${pct(up)} of ${total} probe${total === 1 ? "" : "s"}${bad > 0 ? ` — ${bad} failed` : ""}${mean === null ? "" : `, ${mean}ms mean`}`;
          }),
  });

  // ---- errors ----
  const [newGroups, worstGroups] = await Promise.all([
    prisma.errorGroup.count({ where: { firstSeenAt: { gte: since } } }),
    prisma.errorGroup.findMany({ where: { lastSeenAt: { gte: since } }, orderBy: { count: "desc" }, take: 5 }),
  ]);
  sections.push({
    heading: "Application errors",
    lines: [
      `${newGroups} new group${newGroups === 1 ? "" : "s"} · ${worstGroups.length} active in 24h`,
      ...worstGroups.map((g) => `  ${g.count}× ${g.name}: ${g.message.slice(0, 110)}${g.route ? ` (${g.route})` : ""}`),
      ...(worstGroups.length === 0 ? ["  Nothing threw."] : []),
    ],
  });

  // ---- connectors ----
  const syncs = await prisma.syncRun.groupBy({
    by: ["provider", "status"],
    where: { startedAt: { gte: since } },
    _count: { _all: true },
  });
  const byProvider = new Map<string, { total: number; failed: number }>();
  for (const s of syncs) {
    const p = byProvider.get(s.provider) ?? { total: 0, failed: 0 };
    p.total += s._count._all;
    if (s.status === "FAILED") p.failed += s._count._all;
    byProvider.set(s.provider, p);
  }
  const degraded = [...byProvider.entries()].filter(([, p]) => p.failed > 0).sort((a, b) => b[1].failed - a[1].failed);
  sections.push({
    heading: "Connectors",
    lines:
      byProvider.size === 0
        ? ["No sync ran in 24h."]
        : [
            `${[...byProvider.values()].reduce((a, p) => a + p.total, 0)} runs across ${byProvider.size} providers`,
            ...degraded.slice(0, 6).map(([name, p]) => `  ${name}: ${p.failed}/${p.total} failed`),
            ...(degraded.length === 0 ? ["  All clean."] : []),
          ],
  });

  // ---- deploys ----
  const deploys = await prisma.deploymentRequest.findMany({
    where: { finishedAt: { gte: since } },
    orderBy: { finishedAt: "desc" },
  });
  sections.push({
    heading: "Deployments",
    lines:
      deploys.length === 0
        ? ["Nothing shipped."]
        : deploys.map((d) => `  ${d.service} ${d.fromTag ?? "?"} → ${d.toTag} — ${d.status.toLowerCase()}, by ${d.requestedByEmail}`),
  });

  // ---- durability, including the absence ----
  const [drill, host] = await Promise.all([
    prisma.restoreDrill.findFirst({ orderBy: { at: "desc" } }),
    readHostReport().catch(() => null),
  ]);
  const backup = host?.facts?.backup ?? null;
  const durability: string[] = [];
  durability.push(
    backup?.lastAt
      ? `  Last backup ${backup.lastAt} (${backup.lastBytes === null ? "size unknown" : `${(backup.lastBytes / 1e6).toFixed(0)}MB`})`
      : "  No backup recorded — this is the only copy of the data.",
  );
  durability.push(
    drill === null
      ? "  NO RESTORE HAS EVER BEEN REHEARSED. An unrestored dump is a file with a reassuring name."
      : drill.ok
        ? `  Last restore drill ${drill.at.toISOString().slice(0, 10)}: restored ${drill.orders ?? "?"} orders across ${drill.tables ?? "?"} tables in ${Math.round((drill.durationMs ?? 0) / 1000)}s.`
        : `  Last restore drill ${drill.at.toISOString().slice(0, 10)} FAILED: ${drill.error ?? "no message"}`,
  );
  sections.push({ heading: "Durability", lines: durability });

  // ---- money ----
  const month = now.toISOString().slice(0, 7);
  const snap = await prisma.costSnapshot.findUnique({ where: { month } });
  sections.push({
    heading: "Spend, month to date",
    lines: snap
      ? [
          `  Cloud ${usd(snap.gcpUsdMicro)} (priced floor, not an invoice) · AI ${usd(snap.aiUsdMicro)} (measured from tokens)`,
          `  ${snap.orders.toLocaleString("en-IN")} orders · ${snap.activeOrgs} active organisations`,
          ...(snap.orders > 0
            ? [`  ${usd(Number(snap.gcpUsdMicro + snap.aiUsdMicro) / snap.orders)} per order`]
            : []),
          ...(env.GCP_BILLING_BQ_DATASET ? [] : ["  No billing export configured, so none of this is invoiced truth."]),
        ]
      : ["  No cost snapshot for this month yet."],
  });

  const subject = `CFOOS daily — ${day} — ${pages.length} page, ${firing.length} open, ${newGroups} new error group${newGroups === 1 ? "" : "s"}`;
  const text = [
    ...sections.flatMap((s) => [s.heading.toUpperCase(), ...s.lines, ""]),
    "https://internals.d2ccfo.xyz/",
  ].join("\n");

  return { day, subject, sections, text };
}

/**
 * Send, at most once per UTC day.
 *
 * Called on the same minute tick as everything else; it decides for itself
 * whether this is the moment. That is deliberately simpler than a cron: no
 * schedule to be overdue, no queue to be stuck, and a worker that was down at
 * 03:00 still sends at 03:04 when it comes back rather than skipping the day.
 */
export async function maybeSendDigest(now = new Date()): Promise<"sent" | "already-sent" | "not-yet" | "no-channel"> {
  if (now.getUTCHours() < SEND_HOUR_UTC) return "not-yet";

  const day = now.toISOString().slice(0, 10);
  const state = await prisma.internalOpsState.findUnique({ where: { key: DIGEST_KEY } });
  if (state && (state.value as { day?: string }).day === day) return "already-sent";

  if (!env.INTERNAL_ALERT_WEBHOOK && !(env.RESEND_API_KEY && env.INTERNAL_ALERT_EMAIL && env.DIGEST_FROM_EMAIL)) {
    // The marker is NOT written. The moment a channel is configured, that day's
    // digest goes out rather than being skipped because a clock passed while
    // nothing could receive it.
    return "no-channel";
  }

  const digest = await buildDigest(now);
  const delivered = await deliver(digest);
  if (!delivered) return "no-channel";

  await prisma.internalOpsState.upsert({
    where: { key: DIGEST_KEY },
    create: { key: DIGEST_KEY, value: { day, at: now.toISOString() } },
    update: { value: { day, at: now.toISOString() } },
  });
  logger.info({ day }, "digest_sent");
  return "sent";
}

async function deliver(digest: Digest): Promise<boolean> {
  let ok = false;
  if (env.INTERNAL_ALERT_WEBHOOK) {
    try {
      const res = await fetch(env.INTERNAL_ALERT_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `*${digest.subject}*\n\`\`\`\n${digest.text}\n\`\`\`` }),
        signal: AbortSignal.timeout(10_000),
      });
      ok = res.ok;
    } catch (err) {
      logger.warn({ err }, "digest_webhook_failed");
    }
  }
  if (env.RESEND_API_KEY && env.INTERNAL_ALERT_EMAIL && env.DIGEST_FROM_EMAIL) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: env.DIGEST_FROM_EMAIL,
          to: env.INTERNAL_ALERT_EMAIL.split(",").map((s) => s.trim()).filter(Boolean),
          subject: digest.subject,
          text: digest.text,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      ok = ok || res.ok;
    } catch (err) {
      logger.warn({ err }, "digest_email_failed");
    }
  }
  return ok;
}

const INTERVAL_MS = 300_000;
let timer: NodeJS.Timeout | null = null;

export function startDigest(intervalMs = INTERVAL_MS): void {
  if (timer) return;
  const tick = () => {
    void maybeSendDigest().catch((err: unknown) => logger.error({ err }, "digest_failed"));
  };
  timer = setInterval(tick, intervalMs);
  timer.unref();
}

export function stopDigest(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
