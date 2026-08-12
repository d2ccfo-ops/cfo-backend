import { readFile } from "node:fs/promises";
import { prisma } from "../src/lib/prisma.js";
import {
  decideCashThresholdNotification,
  decideReconExceptionNotification,
  decideSyncFailureNotifications,
  decideVendorPaymentNotification,
  emitNotification,
  runNotificationRules,
  runNotificationSweep,
} from "../src/modules/notifications/notifications.js";
import { findDemoOrg } from "./lib/demoOrg.js";

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(l: string, c: boolean, d = "") {
  if (c) pass += 1; else { fail += 1; failures.push(`${l}${d ? ` — ${d}` : ""}`); }
  console.log(`  ${c ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
}

async function main() {
  const org = await findDemoOrg();
  if (!org) { console.log("no demo organisation"); process.exit(1); }

  console.log("\n[1] rules are pure and refuse to invent thresholds");
  ok("no threshold configured → no cash notification",
    decideCashThresholdNotification(org.id, 100n, null, true).length === 0);
  ok("no bank connected → no cash notification even with a threshold",
    decideCashThresholdNotification(org.id, 100n, "500000", false).length === 0);
  ok("above threshold → nothing",
    decideCashThresholdNotification(org.id, 600000n, "500000", true).length === 0);
  const below = decideCashThresholdNotification(org.id, 400000n, "500000", true);
  ok("below threshold → one CRITICAL", below.length === 1 && below[0]!.severity === "CRITICAL");
  ok("and it states both figures in rupees", /₹4,000/.test(below[0]!.body) && /₹5,000/.test(below[0]!.body), below[0]!.body);
  ok("keyed to the condition, not the balance — so a ₹1 move does not re-notify",
    decideCashThresholdNotification(org.id, 399999n, "500000", true)[0]!.dedupeKey === below[0]!.dedupeKey);

  console.log("\n[2] sync rules separate 'errored' from 'silently not running'");
  const errored = decideSyncFailureNotifications(org.id, [
    { connectionId: "c1", provider: "SHOPIFY", status: "ACTIVE", lastSyncError: "401 Unauthorized", fresh: false, ageMinutes: 100 },
  ]);
  ok("an errored connection is CRITICAL", errored.length === 1 && errored[0]!.severity === "CRITICAL");
  ok("and quotes the provider's own error verbatim", /401 Unauthorized/.test(errored[0]!.body));
  const stale = decideSyncFailureNotifications(org.id, [
    { connectionId: "c2", provider: "BANK", status: "ACTIVE", lastSyncError: null, fresh: false, ageMinutes: 3000 },
  ]);
  ok("stale-but-not-errored is a WARNING, not silence", stale.length === 1 && stale[0]!.severity === "WARNING");
  const never = decideSyncFailureNotifications(org.id, [
    { connectionId: "c3", provider: "GOKWIK", status: "ACTIVE", lastSyncError: null, fresh: false, ageMinutes: null },
  ]);
  ok("never-synced says so rather than reporting an age", /never completed a sync/.test(never[0]!.body));
  ok("a non-ACTIVE connection is not a source and is ignored",
    decideSyncFailureNotifications(org.id, [
      { connectionId: "c4", provider: "AMAZON", status: "PENDING", lastSyncError: "boom", fresh: false, ageMinutes: null },
    ]).length === 0);

  console.log("\n[3] a percentage over a handful of rows is noise, not a signal");
  ok("3 of 5 needing review does not fire",
    decideReconExceptionNotification(org.id, [{ matchType: "ORDER_PAYMENT", state: "ran", eligible: 5, needsReview: 3 }], "2026-08-12").length === 0);
  const spike = decideReconExceptionNotification(org.id, [{ matchType: "ORDER_PAYMENT", state: "ran", eligible: 2000, needsReview: 300 }], "2026-08-12");
  ok("15% of 2000 fires", spike.length === 1, `${spike.length}`);
  ok("40%+ escalates to CRITICAL",
    decideReconExceptionNotification(org.id, [{ matchType: "ORDER_PAYMENT", state: "ran", eligible: 2000, needsReview: 900 }], "2026-08-12")[0]!.severity === "CRITICAL");
  ok("an unavailable leg cannot spike",
    decideReconExceptionNotification(org.id, [{ matchType: "COD_REMITTANCE", state: "unavailable", eligible: 2000, needsReview: 900 }], "2026-08-12").length === 0);

  console.log("\n[4] payables");
  ok("nothing due, nothing overdue → silence",
    decideVendorPaymentNotification(org.id, { dueNext7Minor: "0", dueNext7Count: 0, overdueMinor: "0", overdueCount: 0 }, "2026-08-12").length === 0);
  const due = decideVendorPaymentNotification(org.id, { dueNext7Minor: "500000", dueNext7Count: 2, overdueMinor: "120000", overdueCount: 1 }, "2026-08-12");
  ok("overdue and due-soon are separate notifications", due.length === 2);
  ok("overdue outranks due-soon", due.find((d) => /overdue/.test(d.title))!.severity === "WARNING" && due.find((d) => /due in/.test(d.title))!.severity === "INFO");
  ok("re-keyed per day, because which bills are overdue changes daily",
    decideVendorPaymentNotification(org.id, { dueNext7Minor: "500000", dueNext7Count: 2, overdueMinor: "120000", overdueCount: 1 }, "2026-08-13")[0]!.dedupeKey !== due[0]!.dedupeKey);

  console.log("\n[5] emit dedupes, and never marches a read row back to unread");
  const key = `notif:test:${org.id}:${Date.now()}`;
  const c = { type: "DATA_STALE" as const, severity: "WARNING" as const, title: "t", body: "b", dedupeKey: key };
  ok("first emit creates", (await emitNotification(org.id, c)) === "created");
  ok("second emit updates", (await emitNotification(org.id, c)) === "updated");
  await prisma.notification.update({ where: { dedupeKey: key }, data: { readAt: new Date() } });
  await emitNotification(org.id, { ...c, body: "changed" });
  const after = await prisma.notification.findUnique({ where: { dedupeKey: key } });
  ok("a read notification stays read while the condition persists", after?.readAt !== null);
  ok("but its body refreshes", after?.body === "changed");
  await prisma.notification.delete({ where: { dedupeKey: key } });

  console.log("\n[6] against real data");
  const run = await runNotificationRules(org.id);
  console.log(`     ${org.name}: ${run.candidates} candidates, ${run.created} created, ${run.updated} updated`);
  const again = await runNotificationRules(org.id);
  ok("a second run creates nothing new", again.created === 0, `${again.created}`);
  ok("and still sees the same candidates", again.candidates === run.candidates);
  const rows = await prisma.notification.findMany({ where: { organizationId: org.id }, take: 8, orderBy: { createdAt: "desc" } });
  for (const r of rows) console.log(`     [${r.severity}] ${r.title}`);
  ok("every notification has a non-empty body", rows.every((r) => r.body.length > 10));
  ok("no notification body contains a bare decimal number", rows.every((r) => !/(?<![₹\d])\d+\.\d+(?!\s*%)/.test(r.body)), rows.find((r) => /(?<![₹\d])\d+\.\d+(?!\s*%)/.test(r.body))?.body ?? "");

  console.log("\n[7] the sweep terminates and does not open a Redis connection");
  const started = Date.now();
  const sweep = await runNotificationSweep();
  ok("visited every organisation", sweep.ran + sweep.failed === sweep.organizations, `${sweep.ran}/${sweep.organizations} in ${Date.now() - started}ms`);
  ok("nothing failed", sweep.failed === 0);
  const src = await readFile(new URL("../src/modules/notifications/notifications.ts", import.meta.url), "utf8");
  ok("the module does not import the queue layer", !/from\s+["'].*modules\/queue\//.test(src));
  ok("nor bullmq or redis directly", !/from\s+["'](bullmq|.*lib\/redis)/.test(src));

  console.log("\n[8] the bell reads what the server serialises");
  // Clerk-gates the dashboard, so no script can render the dropdown. What CAN
  // be checked is the seam that breaks silently: a field the component reads by
  // name which the response does not carry renders a blank row.
  const { pathToFileURL } = await import("node:url");
  const bell = await readFile(
    new URL("../../cfo-frontend/components/layout/NotificationBell.js", pathToFileURL(import.meta.dirname + "/")),
    "utf8"
  );
  const { serializeNotification } = await import("../src/routes/notifications.js");
  const sample = await prisma.notification.findFirst({ where: { organizationId: org.id } });
  if (sample) {
    const wire = serializeNotification(sample) as Record<string, unknown>;
    const read = [...new Set([...bell.matchAll(/\bn\.([A-Za-z]+)/g)].map((m) => m[1]!))];
    ok("the bell reads at least one field", read.length > 0, read.join(", "));
    for (const f of read) ok(`notification.${f} exists on the wire shape`, f in wire);
    ok("severity has a dot colour for every value the server can emit",
      ["CRITICAL", "WARNING", "INFO"].every((s) => new RegExp(`${s}:`).test(bell)));
    ok("the badge uses the server's unreadCount, not the list length", /unreadCount/.test(bell) && !/items\.length.*unread/i.test(bell));
  } else {
    ok("no notification to compare against", true);
  }

  console.log("\n" + "─".repeat(60));
  console.log(`${pass} passed, ${fail} failed`);
  if (failures.length) failures.forEach((f) => console.log(`  ✗ ${f}`));
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
