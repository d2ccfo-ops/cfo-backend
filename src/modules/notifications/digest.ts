import { env } from "../../config/env.js";
import { DEFAULT_TIMEZONE, zonedDayKey } from "../../lib/dateRange.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { getDailySnapshotDiff, type DailyMetricMove } from "../calc/dailySnapshot.js";
import { formatInr } from "../calc/money.js";
import { getOrgSettings } from "../orgs/settings.js";

// P3.3 email digests.
//
// Sent over Resend's HTTP API with plain fetch rather than the `resend` npm
// package. The package is one POST wrapped in a client, and this project has
// already had to rip out a dependency (xlsx, two unpatched HIGH CVEs and no
// upstream fix) — an SDK earning its keep has to do more than build a JSON
// body. If Resend's API shape changes this is one function to edit.
//
// The digest is DERIVED, never computed here. Every figure comes from the
// P2.2d snapshot history and the notification table, both of which already
// hold numbers the deterministic engine produced. An email that did its own
// arithmetic could disagree with the dashboard, and the founder would have no
// way to tell which was right.

export const DIGEST_VERSION = "v1";

export type DigestKind = "daily" | "weekly";

export interface DigestContent {
  subject: string;
  /** Plain text. Deliberately the primary format — see buildHtml below. */
  text: string;
  html: string;
  /** False when there is genuinely nothing worth an email. */
  worthSending: boolean;
  reason?: string;
}

function arrow(m: DailyMetricMove): string {
  if (m.direction === null || m.direction === "flat") return "no change";
  const good =
    m.metric.betterWhen === null ? "" : (m.direction === "up") === (m.metric.betterWhen === "higher") ? " ✓" : " ✗";
  const magnitude =
    m.deltaMinor !== null
      ? formatInr(BigInt(m.deltaMinor) < 0n ? -BigInt(m.deltaMinor) : BigInt(m.deltaMinor))
      : m.deltaNumeric !== null
        ? String(Math.abs(m.deltaNumeric))
        : "";
  return `${m.direction === "up" ? "up" : "down"} ${magnitude}${good}`;
}

function valueOf(m: DailyMetricMove): string {
  if (m.current.valueMinor !== null) return formatInr(BigInt(m.current.valueMinor));
  if (m.current.valueNumeric === null) return "—";
  return m.metric.unit === "pct"
    ? `${m.current.valueNumeric}%`
    : m.metric.unit === "months"
      ? `${m.current.valueNumeric} months`
      : String(m.current.valueNumeric);
}

export interface DigestInputs {
  orgName: string;
  kind: DigestKind;
  day: string;
  moves: DailyMetricMove[];
  notifications: Array<{ severity: string; title: string; body: string }>;
}

/**
 * Build the digest. Pure — no database, no network — so what an email says can
 * be tested without sending one.
 *
 * Returns worthSending: false rather than an empty email. A daily digest that
 * arrives every morning saying nothing is how a founder learns to filter the
 * sender, and after that the one that matters is unread too.
 */
export function buildDigest(i: DigestInputs): DigestContent {
  const critical = i.notifications.filter((n) => n.severity === "CRITICAL");
  const warnings = i.notifications.filter((n) => n.severity === "WARNING");
  const moved = i.moves.filter((m) => m.direction !== null && m.direction !== "flat");

  if (i.notifications.length === 0 && moved.length === 0) {
    return {
      subject: "",
      text: "",
      html: "",
      worthSending: false,
      reason:
        i.moves.length === 0
          ? "No snapshot history for this organisation yet — the nightly capture has not run, or every source was stale."
          : "Nothing changed and nothing needs attention.",
    };
  }

  const label = i.kind === "daily" ? "Daily brief" : "Weekly summary";
  // The subject carries the single most important fact, because on a phone it
  // is often the only part that gets read.
  const headline = critical.length > 0 ? `${critical.length} critical` : moved.length > 0 ? `${moved.length} changed` : "";
  const subject = `${label} · ${i.orgName}${headline ? ` · ${headline}` : ""}`;

  const lines: string[] = [`${label} — ${i.orgName}`, `As of ${i.day}`, ""];

  if (critical.length > 0) {
    lines.push("NEEDS ATTENTION");
    for (const n of critical) lines.push(`  • ${n.title} — ${n.body}`);
    lines.push("");
  }
  if (moved.length > 0) {
    lines.push("WHAT MOVED");
    for (const m of moved) lines.push(`  • ${m.metric.label}: ${valueOf(m)} (${arrow(m)})`);
    lines.push("");
  }
  if (warnings.length > 0) {
    lines.push("WORTH KNOWING");
    for (const n of warnings) lines.push(`  • ${n.title}`);
    lines.push("");
  }

  // Said in every email, not buried in a footer. These figures are computed
  // deterministically and this message is a transcription of them — if it ever
  // disagrees with the dashboard, the dashboard is right.
  lines.push("Figures are from the overnight snapshot. Open CFOOS for the live position.");

  const text = lines.join("\n");
  return { subject, text, html: buildHtml(i, { critical, warnings, moved }), worthSending: true };
}

// Deliberately austere HTML: a table-free, image-free, single-column document
// with inline styles. Every mail client renders it, none of it needs a remote
// fetch to be readable, and nothing in it can leak a read receipt. The text
// part above stays the source of truth for CONTENT — this only styles it.
function buildHtml(
  i: DigestInputs,
  parts: { critical: DigestInputs["notifications"]; warnings: DigestInputs["notifications"]; moved: DailyMetricMove[] }
): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const section = (title: string, rows: string[]) =>
    rows.length === 0
      ? ""
      : `<p style="margin:22px 0 8px;font:600 11px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#6b7280">${esc(title)}</p>` +
        rows.map((r) => `<p style="margin:0 0 8px;font:400 14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111827">${r}</p>`).join("");

  return [
    `<div style="max-width:560px;margin:0 auto;padding:24px">`,
    `<p style="margin:0;font:500 18px/1.3 -apple-system,Segoe UI,Roboto,sans-serif;color:#111827">${esc(i.kind === "daily" ? "Daily brief" : "Weekly summary")}</p>`,
    `<p style="margin:2px 0 0;font:400 13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#6b7280">${esc(i.orgName)} · as of ${esc(i.day)}</p>`,
    section(
      "Needs attention",
      parts.critical.map((n) => `<strong>${esc(n.title)}</strong><br><span style="color:#6b7280">${esc(n.body)}</span>`)
    ),
    section(
      "What moved",
      parts.moved.map((m) => `${esc(m.metric.label)}: <strong>${esc(valueOf(m))}</strong> <span style="color:#6b7280">(${esc(arrow(m))})</span>`)
    ),
    section("Worth knowing", parts.warnings.map((n) => esc(n.title))),
    `<p style="margin:24px 0 0;font:400 12px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#9ca3af">Figures are from the overnight snapshot. Open CFOOS for the live position.</p>`,
    `</div>`,
  ].join("");
}

export interface SendResult {
  sent: boolean;
  skipped?: string;
  recipients?: number;
  error?: string;
}

/**
 * Post one email to Resend.
 *
 * Missing configuration SKIPS with a stated reason rather than throwing. The
 * digest is an optional feature; an org that never configured it must not turn
 * the nightly sweep into a wall of exceptions.
 */
export async function sendDigestEmail(to: string[], content: DigestContent): Promise<SendResult> {
  if (!env.RESEND_API_KEY) return { sent: false, skipped: "RESEND_API_KEY is not set — email digests are off." };
  if (!env.DIGEST_FROM_EMAIL) return { sent: false, skipped: "DIGEST_FROM_EMAIL is not set — no verified sender." };
  if (to.length === 0) return { sent: false, skipped: "No recipients configured." };

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.DIGEST_FROM_EMAIL,
        // bcc, not to: a digest carries the organisation's cash position, and
        // putting five recipients in a visible To exposes who else receives it
        // — to their accountant, their investor, and anyone forwarded the mail.
        to: env.DIGEST_FROM_EMAIL,
        bcc: to,
        subject: content.subject,
        text: content.text,
        html: content.html,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { sent: false, error: `Resend responded ${res.status}: ${body.slice(0, 200)}` };
    }
    return { sent: true, recipients: to.length };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface DigestSweepResult {
  kind: DigestKind;
  organizations: number;
  eligible: number;
  sent: number;
  skipped: Array<{ organizationId: string; reason: string }>;
  failed: Array<{ organizationId: string; error: string }>;
}

export async function runDigestSweep(kind: DigestKind, now: Date = new Date()): Promise<DigestSweepResult> {
  const organizations = await prisma.organization.findMany({ select: { id: true, name: true, timezone: true } });
  const result: DigestSweepResult = { kind, organizations: organizations.length, eligible: 0, sent: 0, skipped: [], failed: [] };

  for (const org of organizations) {
    try {
      const settings = await getOrgSettings(org.id);
      const cfg = settings.notificationDigest;
      if (!cfg || !cfg[kind] || cfg.recipients.length === 0) continue;
      result.eligible += 1;

      const [diff, notifications] = await Promise.all([
        getDailySnapshotDiff(org.id, now),
        prisma.notification.findMany({
          where: {
            organizationId: org.id,
            // Unread only. A digest is a nudge about what has not been dealt
            // with; re-sending things someone already read is how a daily email
            // becomes noise.
            readAt: null,
            createdAt: { gte: new Date(now.getTime() - (kind === "daily" ? 1 : 7) * 86_400_000) },
          },
          select: { severity: true, title: true, body: true },
          orderBy: { severity: "asc" },
          take: 20,
        }),
      ]);

      const content = buildDigest({
        orgName: org.name,
        kind,
        day: diff.day ?? zonedDayKey(now, org.timezone ?? DEFAULT_TIMEZONE),
        moves: diff.metrics,
        notifications,
      });

      if (!content.worthSending) {
        result.skipped.push({ organizationId: org.id, reason: content.reason ?? "nothing to say" });
        continue;
      }

      const send = await sendDigestEmail(cfg.recipients, content);
      if (send.sent) result.sent += 1;
      else if (send.error) result.failed.push({ organizationId: org.id, error: send.error });
      else result.skipped.push({ organizationId: org.id, reason: send.skipped ?? "not sent" });
    } catch (err) {
      result.failed.push({ organizationId: org.id, error: err instanceof Error ? err.message : String(err) });
      logger.error({ err, organizationId: org.id }, "digest_sweep_org_failed");
    }
  }

  return result;
}
