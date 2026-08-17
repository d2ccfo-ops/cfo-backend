import type { AlertSeverity } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { env } from "../../config/env.js";
import { readHostReport, AGENT_STALE_AFTER_MS } from "./hostFacts.js";
import { readRedisStats } from "./redisInfo.js";
import { readQueueInventory } from "./queueInventory.js";

// THE PART OF THE CONSOLE THAT SPEAKS FIRST.
//
// Everything else here answers a question. This notices. On 2026-08-17 the
// worker was OOM-killed three times in twenty minutes and every panel in the
// console stayed green throughout, because a panel is green when nobody is
// looking at it. That is the gap this closes.
//
// THREE PROPERTIES, EACH OF WHICH IS A DECISION:
//
//   IT DOES NOT RUN ON THE QUEUE. Every other periodic job in this system is a
//   BullMQ scheduler. This one is a plain interval in the worker process,
//   because several of the conditions below are "the queue is broken" — an
//   evaluator that needs a working queue to tell you the queue is stuck is not
//   an evaluator, it is a second thing that fails silently at the same moment.
//
//   ALERTS ARE KEYED, NOT APPENDED. One row per (rule, subject), updated in
//   place. A queue backed up for an hour is one alert seen sixty times, not
//   sixty alerts. Append-only produces a feed that is unreadable exactly when it
//   matters.
//
//   RULES RESOLVE THEMSELVES. A condition that stops being true clears its own
//   alert. Anything else trains people to ignore the list, and a list people
//   ignore is worse than no list because it looks like coverage.
//
// Severity means what it says: PAGE is "wake someone", WARN is "today", INFO is
// "in the digest". Adding a rule at PAGE that fires weekly is how the whole
// thing gets muted, so the bar is deliberately high and there are few of them.

export interface Finding {
  key: string;
  rule: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
}

const DAY_MS = 86_400_000;

/** A backup older than this has missed its nightly window. */
const BACKUP_STALE_MS = 26 * 3_600_000;
/** A dump this much smaller than the last one is a truncated dump. */
const BACKUP_SHRINK_RATIO = 0.6;
const REDIS_MEMORY_WARN = 0.8;
const QUEUE_BACKLOG_WARN = 100;
const DISK_USED_PAGE = 0.9;
const DISK_DAYS_WARN = 14;
const TLS_DAYS_WARN = 14;
const SYNC_FAIL_RATE_WARN = 0.5;
const SYNC_MIN_RUNS = 5;
/** How far back the outside view is judged. Probes run every 60s. */
const SYNTHETIC_WINDOW_MS = 15 * 60_000;
/** Four in a row is an outage; one during a deploy is noise. */
const SYNTHETIC_CONSECUTIVE = 4;
/** The drill is monthly, so 40 days allows a missed one before complaining. */
const RESTORE_STALE_MS = 40 * 86_400_000;

function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "unknown";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)}${u[i]}`;
}

function hours(ms: number): string {
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * Evaluate every rule. Returns what is true right now.
 *
 * Each source is wrapped: one unreachable subsystem must not stop the rules that
 * do not depend on it. A Redis outage should raise the Redis alert, not silence
 * the backup alert.
 */
export async function collectFindings(now = Date.now()): Promise<Finding[]> {
  const out: Finding[] = [];
  const push = (f: Finding) => out.push(f);

  // ---- host facts: backup, OOM, disk, TLS, agent liveness ----
  try {
    const report = await readHostReport();

    if (report.stale) {
      push({
        key: "agent.silent",
        rule: "agent.silent",
        severity: "WARN",
        title: "The deploy agent has stopped reporting",
        detail:
          report.seenAt === null
            ? "It has never reported. Deployments and every host fact below are unavailable."
            : `Last seen ${report.secondsAgo}s ago, past the ${AGENT_STALE_AFTER_MS / 1000}s threshold. On the VM: systemctl status cfoos-deploy-agent.timer`,
      });
    }

    const f = report.facts;

    if (f?.backup) {
      const b = f.backup;
      const lastMs = b.lastAt ? now - Date.parse(b.lastAt) : null;
      if (lastMs === null) {
        push({
          key: "backup.missing",
          rule: "backup.missing",
          severity: "PAGE",
          title: "No database backup has been recorded",
          detail: b.error ?? "The agent found no backup in the bucket. This is the only copy of the data.",
        });
      } else if (lastMs > BACKUP_STALE_MS) {
        push({
          key: "backup.stale",
          rule: "backup.stale",
          severity: "PAGE",
          title: `The last backup is ${hours(lastMs)} old`,
          detail: `Nightly dump to ${b.bucket ?? "the backup bucket"} has missed its window (${b.scheduleUtc ?? "19:30 UTC"}). Last: ${b.lastAt}, ${bytes(b.lastBytes)}.`,
        });
      }
      // A pg_dump that dies mid-stream still exits 0 through the pipe and leaves
      // a small, valid gzip. Size collapse is the only signal that catches it.
      if (b.lastBytes !== null && b.previousBytes !== null && b.previousBytes > 0) {
        const ratio = b.lastBytes / b.previousBytes;
        if (ratio < BACKUP_SHRINK_RATIO) {
          push({
            key: "backup.shrunk",
            rule: "backup.shrunk",
            severity: "PAGE",
            title: "The newest backup is far smaller than the one before it",
            detail: `${bytes(b.lastBytes)} against ${bytes(b.previousBytes)} — ${Math.round(ratio * 100)}%. A dump that fails mid-stream still exits cleanly; treat this as truncated until proven otherwise.`,
          });
        }
      }
    }

    // Every kill gets its own key, so three kills are three alerts and the
    // count is legible. They resolve when the kill scrolls out of the window
    // the agent reports.
    for (const k of f?.oom ?? []) {
      push({
        key: `host.oom:${k.at}`,
        rule: "host.oom",
        severity: "PAGE",
        title: `The kernel killed ${k.process} for using too much memory`,
        detail: `${k.at} — RSS ${bytes(k.rssBytes)}. A container hit its cgroup limit. Docker's own OOMKilled flag resets when a container is recreated, so this is the only durable record.`,
      });
    }

    if (f?.disk) {
      const d = f.disk;
      if (d.usedPercent !== null && d.usedPercent > DISK_USED_PAGE * 100) {
        push({
          key: "disk.full",
          rule: "disk.full",
          severity: "PAGE",
          title: `Disk is ${d.usedPercent.toFixed(0)}% full`,
          detail: `${bytes(d.freeBytes)} free. Postgres stops accepting writes before this reaches zero.`,
        });
      } else if (d.daysUntilFull !== null && d.daysUntilFull < DISK_DAYS_WARN) {
        push({
          key: "disk.filling",
          rule: "disk.filling",
          severity: "WARN",
          title: `Disk fills in about ${Math.round(d.daysUntilFull)} days at the current rate`,
          detail: `${bytes(d.freeBytes)} free of ${bytes(d.totalBytes)}. Projected from the agent's own samples, so it follows real growth rather than an assumption.`,
        });
      }
    }

    for (const t of f?.tls ?? []) {
      if (t.daysRemaining !== null && t.daysRemaining < TLS_DAYS_WARN) {
        push({
          key: `tls.expiring:${t.host}`,
          rule: "tls.expiring",
          severity: "WARN",
          title: `${t.host}'s certificate expires in ${t.daysRemaining} days`,
          detail: `Caddy renews automatically, which is exactly why a failed renewal is silent until a browser refuses the site. Expires ${t.notAfter}.`,
        });
      }
    }

    for (const c of f?.containers ?? []) {
      if (c.memPercent !== null && c.memPercent > 90) {
        push({
          key: `container.memory:${c.name}`,
          rule: "container.memory",
          severity: "WARN",
          title: `${c.name} is at ${c.memPercent.toFixed(0)}% of its memory limit`,
          detail: `${bytes(c.memUsedBytes)} of ${bytes(c.memLimitBytes)}. The kernel kills the process rather than throttling it.`,
        });
      }
    }
  } catch (err) {
    logger.warn({ err }, "alert_host_facts_failed");
  }

  // ---- Redis ----
  try {
    const r = await readRedisStats();
    if (r.error) {
      push({
        key: "redis.unreachable",
        rule: "redis.unreachable",
        severity: "PAGE",
        title: "Redis is unreachable",
        detail: `${r.error}. The queue stops, every dashboard read recomputes, and the rate limiter fails open.`,
      });
    } else if (r.memoryUsedRatio !== null && r.memoryUsedRatio > REDIS_MEMORY_WARN) {
      push({
        key: "redis.memory",
        rule: "redis.memory",
        severity: r.writesFailWhenFull ? "PAGE" : "WARN",
        title: `Redis is at ${(r.memoryUsedRatio * 100).toFixed(0)}% of maxmemory`,
        detail: r.writesFailWhenFull
          ? `Policy is noeviction: when it fills, writes FAIL rather than evicting. That breaks the queue, the response cache and the rate limiter at the same moment, presenting as three unrelated faults.`
          : `Policy is ${r.maxMemoryPolicy}. ${bytes(r.usedMemoryBytes)} of ${bytes(r.maxMemoryBytes)}.`,
      });
    }
  } catch (err) {
    logger.warn({ err }, "alert_redis_failed");
  }

  // ---- queues and schedules ----
  try {
    const inv = await readQueueInventory();
    if (inv.error) {
      push({
        key: "queue.unreadable",
        rule: "queue.unreadable",
        severity: "WARN",
        title: "The queues could not be read",
        detail: inv.error,
      });
    }
    for (const q of inv.queues) {
      if (q.waiting > QUEUE_BACKLOG_WARN) {
        push({
          key: `queue.backlog:${q.name}`,
          rule: "queue.backlog",
          severity: "WARN",
          title: `${q.name} has ${q.waiting} jobs waiting`,
          detail: `${q.active} active, ${q.failed} retained failures. Work is arriving faster than it is being consumed, or nothing is consuming it.`,
        });
      }
      if (q.isPaused) {
        push({
          key: `queue.paused:${q.name}`,
          rule: "queue.paused",
          severity: "WARN",
          title: `${q.name} is paused`,
          detail: "Jobs are accumulating and nothing will run until it is resumed.",
        });
      }
      for (const s of q.schedulers) {
        if (!s.overdue) continue;
        const lateMs = s.nextRunAt ? now - Date.parse(s.nextRunAt) : 0;
        push({
          key: `schedule.overdue:${s.id}`,
          rule: "schedule.overdue",
          severity: lateMs > DAY_MS ? "PAGE" : "WARN",
          title: `${s.id} is ${hours(lateMs)} overdue`,
          detail: `BullMQ only moves a schedule's next fire forward when a worker consumes it, so a time in the past means nothing is consuming it — the worker is down or wedged.`,
        });
      }
    }
  } catch (err) {
    logger.warn({ err }, "alert_queues_failed");
  }

  // ---- connector health, from sync_runs ----
  //
  // GROUPED BY TENANT AS WELL AS PROVIDER, and the reason is a failure mode this
  // rule had in production on its first day: nine WARNs fired at once, every one
  // of them a seeded DEMO organisation whose credentials cannot decrypt. Nine
  // permanent warnings is how the whole list gets ignored, and the tenth — a
  // real customer — would have arrived into a page nobody reads any more.
  //
  // The fix is NOT to exclude demo tenants. Their syncs failing is true, and a
  // regression in the seed data is worth knowing about. It is to separate the
  // two populations: a provider failing only for demo tenants is INFO, which
  // reaches the daily digest and nothing else. One real tenant among them and it
  // is a WARN again, and the count of real tenants is in the message.
  try {
    const since = new Date(now - DAY_MS);
    const [rows, orgs] = await Promise.all([
      prisma.syncRun.groupBy({
        by: ["provider", "status", "organizationId"],
        where: { startedAt: { gte: since } },
        _count: { _all: true },
      }),
      prisma.organization.findMany({ select: { id: true, name: true } }),
    ]);
    // The seeder prefixes every organisation it creates. A name test rather than
    // a flag column because that prefix IS the marker the seeder guarantees —
    // see the demo-data seeder; anything else would be a second thing to keep
    // in step.
    const demo = new Set(orgs.filter((o) => o.name.startsWith("DEMO")).map((o) => o.id));

    const byProvider = new Map<string, { total: number; failed: number; realOrgs: Set<string>; demoOrgs: Set<string> }>();
    for (const r of rows) {
      const p = byProvider.get(r.provider) ?? { total: 0, failed: 0, realOrgs: new Set<string>(), demoOrgs: new Set<string>() };
      p.total += r._count._all;
      if (r.status === "FAILED") {
        p.failed += r._count._all;
        (demo.has(r.organizationId) ? p.demoOrgs : p.realOrgs).add(r.organizationId);
      }
      byProvider.set(r.provider, p);
    }

    for (const [provider, p] of byProvider) {
      if (p.total < SYNC_MIN_RUNS) continue;
      const rate = p.failed / p.total;
      if (rate <= SYNC_FAIL_RATE_WARN) continue;

      const realCount = p.realOrgs.size;
      push({
        key: `sync.failing:${provider}`,
        rule: "sync.failing",
        severity: realCount > 0 ? "WARN" : "INFO",
        title:
          realCount > 0
            ? `${provider} syncs are failing ${(rate * 100).toFixed(0)}% of the time`
            : `${provider} syncs fail for demo tenants only`,
        detail:
          realCount > 0
            ? `${p.failed} of ${p.total} runs in the last 24 hours, across ${realCount} real ${realCount === 1 ? "tenant" : "tenants"}${p.demoOrgs.size > 0 ? ` (and ${p.demoOrgs.size} demo)` : ""}. Customers on this connector are looking at stale figures.`
            : `${p.failed} of ${p.total} runs failed, all of them for ${p.demoOrgs.size} seeded demo ${p.demoOrgs.size === 1 ? "organisation" : "organisations"}. No customer is affected, so this is INFO — it reaches the daily digest and nobody's phone.`,
      });
    }
  } catch (err) {
    logger.warn({ err }, "alert_sync_failed");
  }

  // ---- what the outside saw ----
  //
  // THE ONLY RULE HERE THAT CAN FIRE WHEN THE APP IS DOWN. Every rule above
  // reads a subsystem from inside; this one reads the record of somebody
  // knocking on the front door.
  try {
    const since = new Date(now - SYNTHETIC_WINDOW_MS);
    const [recent, failed] = await Promise.all([
      prisma.syntheticCheck.groupBy({ by: ["target"], where: { at: { gte: since } }, _count: { _all: true } }),
      prisma.syntheticCheck.groupBy({ by: ["target"], where: { at: { gte: since }, ok: false }, _count: { _all: true } }),
    ]);
    const failMap = new Map(failed.map((f) => [f.target, f._count._all]));

    if (recent.length === 0) {
      // The prober itself. A silent prober and a healthy product produce
      // exactly the same rows — none — so the absence has to be its own alert
      // or the whole outside view fails open.
      push({
        key: "synthetic.silent",
        rule: "synthetic.silent",
        severity: "WARN",
        title: "Nothing has probed the public sites",
        detail: `No synthetic check recorded in the last ${SYNTHETIC_WINDOW_MS / 60_000} minutes. A prober that has stopped looks exactly like a product that is fine.`,
      });
    }

    for (const r of recent) {
      const bad = failMap.get(r.target) ?? 0;
      if (bad === 0) continue;
      const total = r._count._all;
      // Consecutive failures matter more than a rate: one 502 during a deploy
      // is noise, four in a row is an outage. The last N probes are read
      // directly rather than inferred from the ratio.
      const last = await prisma.syntheticCheck.findMany({
        where: { target: r.target }, orderBy: { at: "desc" }, take: SYNTHETIC_CONSECUTIVE,
      });
      const allBad = last.length === SYNTHETIC_CONSECUTIVE && last.every((c) => !c.ok);
      if (!allBad && bad / total < 0.25) continue;
      const newest = last[0];
      push({
        key: `synthetic.down:${r.target}`,
        rule: "synthetic.down",
        severity: allBad ? "PAGE" : "WARN",
        title: allBad
          ? `${r.target} has failed its last ${SYNTHETIC_CONSECUTIVE} checks`
          : `${r.target} failed ${bad} of ${total} checks`,
        detail: `${newest?.url ?? ""} — ${newest?.error ?? "no message"}${newest?.statusCode ? ` (HTTP ${newest.statusCode})` : ""}. Probed from the VM itself, so this is DNS, TLS, Caddy or the app, not the path from outside this datacenter.`,
      });
    }
  } catch (err) {
    logger.warn({ err }, "alert_synthetic_failed");
  }

  // ---- has the backup ever been restored? ----
  //
  // The only rule in this file that fires on the ABSENCE of an event. Every
  // other one waits for something to go wrong; this one is true from the moment
  // the system exists and stays true until somebody proves the data can be
  // recovered. A dump that has never been restored is a file with a reassuring
  // name, and all three backup rules above pass for one.
  try {
    const lastOk = await prisma.restoreDrill.findFirst({ where: { ok: true }, orderBy: { at: "desc" } });
    const lastAny = await prisma.restoreDrill.findFirst({ orderBy: { at: "desc" } });
    if (lastAny && !lastAny.ok && (lastOk === null || lastAny.at > lastOk.at)) {
      push({
        key: "restore.failed",
        rule: "restore.failed",
        severity: "PAGE",
        title: "The last restore drill failed",
        detail: `${lastAny.at.toISOString()} — ${lastAny.error ?? "no message"}. The nightly dump is running and cannot be loaded back.`,
      });
    } else if (lastOk === null) {
      push({
        key: "restore.never",
        rule: "restore.never",
        severity: "WARN",
        title: "No backup has ever been restored",
        detail:
          "The nightly dump has never been loaded back into a database. Until it has, its recoverability is an assumption. The agent rehearses monthly; if this persists, the drill is not running.",
      });
    } else if (now - lastOk.at.getTime() > RESTORE_STALE_MS) {
      push({
        key: "restore.stale",
        rule: "restore.stale",
        severity: "WARN",
        title: `The last successful restore drill was ${Math.round((now - lastOk.at.getTime()) / DAY_MS)} days ago`,
        detail: `Monthly is the schedule. A dump format, a Postgres version or a bucket permission can change silently between drills.`,
      });
    }
  } catch (err) {
    logger.warn({ err }, "alert_restore_failed");
  }

  return out;
}

export interface EvaluationResult {
  firing: number;
  opened: string[];
  resolved: string[];
}

/**
 * Reconcile findings against stored alerts.
 *
 * Everything currently open that is NOT in this round's findings gets resolved,
 * which is what makes the list trustworthy: it always describes now, never an
 * accumulation of things that were once true.
 */
export async function evaluateAlerts(now = Date.now()): Promise<EvaluationResult> {
  const findings = await collectFindings(now);
  const at = new Date(now);
  const keys = new Set(findings.map((f) => f.key));

  const opened: string[] = [];
  for (const f of findings) {
    const existing = await prisma.alert.findUnique({ where: { key: f.key } });
    if (existing && existing.resolvedAt === null) {
      await prisma.alert.update({
        where: { key: f.key },
        data: { lastSeenAt: at, seenCount: { increment: 1 }, title: f.title, detail: f.detail, severity: f.severity },
      });
    } else {
      // Either new, or previously resolved and now true again. A recurrence
      // reopens the same row and clears the acknowledgement — an "I've seen it"
      // from last week must not silence today's occurrence.
      await prisma.alert.upsert({
        where: { key: f.key },
        create: { key: f.key, rule: f.rule, severity: f.severity, title: f.title, detail: f.detail, firstSeenAt: at, lastSeenAt: at },
        update: {
          rule: f.rule, severity: f.severity, title: f.title, detail: f.detail,
          firstSeenAt: at, lastSeenAt: at, seenCount: 1,
          resolvedAt: null, acknowledgedAt: null, acknowledgedBy: null, acknowledgedReason: null, notifiedAt: null,
        },
      });
      opened.push(f.key);
    }
  }

  const stillOpen = await prisma.alert.findMany({ where: { resolvedAt: null }, select: { key: true } });
  const toResolve = stillOpen.map((a) => a.key).filter((k) => !keys.has(k));
  if (toResolve.length > 0) {
    await prisma.alert.updateMany({ where: { key: { in: toResolve } }, data: { resolvedAt: at } });
  }

  if (opened.length > 0 || toResolve.length > 0) {
    logger.info({ opened, resolved: toResolve, firing: findings.length }, "alerts_evaluated");
  }

  await notifyUnsent(at).catch((err: unknown) => logger.warn({ err }, "alert_notify_failed"));

  return { firing: findings.length, opened, resolved: toResolve };
}

/**
 * Deliver anything open, unacknowledged and not yet notified.
 *
 * DELIVERY IS OPTIONAL AND EVALUATION IS NOT. With no channel configured this
 * does nothing and says so once — the alerts are still stored, still resolved,
 * still visible on the console. That ordering matters: the expensive half is
 * knowing what is wrong, and it should not wait on someone pasting an API key.
 *
 * Two channels because they fail differently. A webhook is one URL and reaches
 * Slack, Discord or anything else; email survives the webhook host being the
 * thing that is down.
 */
async function notifyUnsent(at: Date): Promise<void> {
  const pending = await prisma.alert.findMany({
    where: { resolvedAt: null, acknowledgedAt: null, notifiedAt: null, severity: { in: ["PAGE", "WARN"] } },
    orderBy: [{ severity: "asc" }, { firstSeenAt: "asc" }],
    take: 20,
  });
  if (pending.length === 0) return;

  const lines = pending.map((a) => `[${a.severity}] ${a.title}\n    ${a.detail}`);
  const subject = `CFOOS: ${pending.length} alert${pending.length === 1 ? "" : "s"} — ${pending[0]?.title ?? ""}`;
  const text = `${lines.join("\n\n")}\n\nhttps://internals.d2ccfo.xyz/alerts`;

  let delivered = false;

  if (env.INTERNAL_ALERT_WEBHOOK) {
    try {
      const res = await fetch(env.INTERNAL_ALERT_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `text` is the field Slack and Discord both read, so one shape reaches
        // either without the agent needing to know which it is talking to.
        body: JSON.stringify({ text: `*${subject}*\n\n${text}` }),
        signal: AbortSignal.timeout(8000),
      });
      delivered = res.ok;
      if (!res.ok) logger.warn({ status: res.status }, "alert_webhook_rejected");
    } catch (err) {
      logger.warn({ err }, "alert_webhook_failed");
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
          subject,
          text,
        }),
        signal: AbortSignal.timeout(8000),
      });
      delivered = delivered || res.ok;
      if (!res.ok) logger.warn({ status: res.status }, "alert_email_rejected");
    } catch (err) {
      logger.warn({ err }, "alert_email_failed");
    }
  }

  if (delivered) {
    await prisma.alert.updateMany({ where: { id: { in: pending.map((a) => a.id) } }, data: { notifiedAt: at } });
  } else if (!env.INTERNAL_ALERT_WEBHOOK && !env.RESEND_API_KEY) {
    // notifiedAt is deliberately NOT stamped: the moment a channel is
    // configured, everything still open is delivered rather than lost to a
    // window when nothing could receive it.
    logger.warn(
      { pending: pending.length },
      "alerts_firing_with_no_delivery_channel_configured",
    );
  }
}

/**
 * Run the evaluator on a timer.
 *
 * A PLAIN INTERVAL, NOT A BULLMQ SCHEDULE, and the reason is in the rules: this
 * evaluator raises "the queue is backed up", "a schedule is overdue", "Redis is
 * unreachable". Putting it on the queue would mean the alarm shares a failure
 * mode with the thing it is alarming about — every one of those conditions
 * would also stop the alarm, and the console would go quiet at the exact moment
 * it should be loudest. Same reasoning as systemSampler and the retention sweep.
 *
 * unref'd so it never keeps the process alive on its own.
 */
const EVALUATE_INTERVAL_MS = 60_000;
let alertTimer: NodeJS.Timeout | null = null;

export function startAlertEvaluator(intervalMs = EVALUATE_INTERVAL_MS): void {
  if (alertTimer) return;
  const tick = () => {
    void evaluateAlerts().catch((err: unknown) => logger.error({ err }, "alert_evaluation_failed"));
  };
  // Immediately, so a restart does not leave a minute in which nothing is
  // watching — which is precisely the minute after a deploy.
  tick();
  alertTimer = setInterval(tick, intervalMs);
  alertTimer.unref();
}

export function stopAlertEvaluator(): void {
  if (!alertTimer) return;
  clearInterval(alertTimer);
  alertTimer = null;
}
