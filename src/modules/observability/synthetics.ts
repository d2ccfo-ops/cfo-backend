import { request } from "node:https";
import type { TLSSocket } from "node:tls";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";

// THE ONLY MEASUREMENT HERE THAT SURVIVES THE SYSTEM GOING DOWN.
//
// Everything else this console reads is written from inside: the API times its
// own handlers, the worker counts its own jobs, the agent reads its own host.
// All of it stops recording at the same instant and in the same way, so the
// last thing the console ever sees before an outage is a healthy system. That
// is not a gap in the panels; it is a property of self-reporting.
//
// This probes the product the way a customer's browser does — resolve the
// public name, complete a TLS handshake against whatever certificate is
// actually being served, fetch the URL, read the status.
//
// WHAT IT HONESTLY IS NOT: an off-site prober. It runs in the worker, which
// runs on the same VM as everything it is probing, so it exercises DNS, TLS,
// Caddy and the app — but not the path from the outside world to this
// datacenter. If the VM is unreachable from the internet while perfectly
// healthy internally, this says healthy. Closing that requires a prober
// somewhere else, and half a loaf here beats the whole loaf never: this catches
// a wedged container, an expired certificate, a broken Caddy route and a 500 on
// the front page, which is most of what actually happens.
//
// EXPECTED STATUS IS PER TARGET, NOT "under 400". dashboard.d2ccfo.xyz answers
// 307 to an anonymous request because it redirects to sign-in, and that 307 is
// the healthy response — a check that wanted 200 there would page every minute
// forever, and a check that accepted "anything under 400" would call a redirect
// loop healthy. Redirects are deliberately NOT followed: the status returned by
// the host under test is the measurement.

export interface Target {
  name: string;
  url: string;
  /** The statuses that mean this endpoint is doing its job. */
  expect: number[];
  /** Substring that must appear in the body, when the body is the point. */
  expectBody?: string;
  /** What a person should understand is broken when this fails. */
  covers: string;
}

export const TARGETS: Target[] = [
  {
    name: "dashboard",
    url: "https://dashboard.d2ccfo.xyz/",
    // 307 is Next.js middleware sending an anonymous visitor to sign-in. That
    // redirect existing is the proof the app booted and the middleware ran.
    expect: [200, 307, 302],
    covers: "the customer-facing console",
  },
  {
    name: "api",
    url: "https://api.d2ccfo.xyz/health",
    expect: [200],
    // /health touches Postgres before answering, so a 200 here is also proof
    // the database is reachable from the API container.
    expectBody: '"status":"ok"',
    covers: "the API and its database connection",
  },
  {
    name: "marketing",
    url: "https://d2ccfo.xyz/",
    // Caddy redirects the apex to www. Following it would test www and report
    // the apex, so the redirect itself is the expectation.
    expect: [301, 308],
    covers: "the public site's apex redirect",
  },
  {
    name: "marketing-www",
    url: "https://www.d2ccfo.xyz/",
    expect: [200],
    covers: "the public site",
  },
  {
    name: "console",
    url: "https://internals.d2ccfo.xyz/",
    expect: [200],
    covers: "this console",
  },
];

const TIMEOUT_MS = 10_000;

export interface ProbeResult {
  target: string;
  url: string;
  ok: boolean;
  statusCode: number | null;
  ms: number | null;
  error: string | null;
  tlsDaysRemaining: number | null;
}

/**
 * One probe.
 *
 * node:https rather than fetch, for one reason: the certificate. fetch gives no
 * access to the peer certificate, so verifying TLS would mean a second
 * connection to a socket that might present something different. Here the
 * handshake being measured and the certificate being read are the same
 * handshake.
 */
export async function probe(t: Target, now = Date.now()): Promise<ProbeResult> {
  const started = Date.now();
  const base = { target: t.name, url: t.url, ms: null, statusCode: null, tlsDaysRemaining: null };

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const finish = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    try {
      const req = request(
        t.url,
        {
          method: "GET",
          timeout: TIMEOUT_MS,
          // A customer's browser sends one. Some hosts behave differently
          // without it, and a probe that is served a different page than a
          // browser is measuring something nobody visits.
          headers: { "User-Agent": "cfoos-synthetic/1 (+https://internals.d2ccfo.xyz)", Accept: "text/html,*/*" },
        },
        (res) => {
          const socket = res.socket as TLSSocket;
          let tlsDays: number | null = null;
          try {
            const cert = socket.getPeerCertificate?.();
            if (cert && cert.valid_to) {
              tlsDays = Math.floor((Date.parse(cert.valid_to) - now) / 86_400_000);
            }
          } catch {
            // A certificate we cannot read is not a failed probe. The handshake
            // already succeeded or we would not be in this callback.
          }

          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on("data", (c: Buffer) => {
            // Bounded. The body is only read to check for a marker string, and
            // a multi-megabyte page should not be buffered to find one.
            if (bytes < 65_536) {
              chunks.push(c);
              bytes += c.length;
            }
          });
          res.on("end", () => {
            const ms = Date.now() - started;
            const status = res.statusCode ?? 0;
            const body = Buffer.concat(chunks).toString("utf8");
            const statusOk = t.expect.includes(status);
            const bodyOk = !t.expectBody || body.includes(t.expectBody);
            finish({
              ...base,
              ok: statusOk && bodyOk,
              statusCode: status,
              ms,
              tlsDaysRemaining: tlsDays,
              error: statusOk
                ? bodyOk
                  ? null
                  : `Answered ${status} but the body does not contain ${t.expectBody}.`
                : `Answered ${status}; expected ${t.expect.join(" or ")}.`,
            });
          });
          res.on("error", (err: Error) => finish({ ...base, ok: false, ms: Date.now() - started, error: err.message }));
        },
      );

      req.on("timeout", () => {
        req.destroy();
        finish({ ...base, ok: false, ms: Date.now() - started, error: `No response within ${TIMEOUT_MS}ms.` });
      });
      // Verbatim, including the code. "getaddrinfo ENOTFOUND" and
      // "ECONNREFUSED" and "certificate has expired" are three different
      // outages with three different fixes, and collapsing them into
      // "unreachable" throws away the only part worth reading.
      req.on("error", (err: NodeJS.ErrnoException) =>
        finish({ ...base, ok: false, ms: Date.now() - started, error: err.code ? `${err.code}: ${err.message}` : err.message }),
      );
      req.end();
    } catch (err) {
      finish({ ...base, ok: false, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** Probe everything, concurrently, and store the results. */
export async function runSyntheticChecks(now = Date.now()): Promise<ProbeResult[]> {
  const results = await Promise.all(TARGETS.map((t) => probe(t, now)));
  try {
    await prisma.syntheticCheck.createMany({
      data: results.map((r) => ({
        target: r.target,
        url: r.url,
        ok: r.ok,
        statusCode: r.statusCode,
        ms: r.ms,
        error: r.error,
        tlsDaysRemaining: r.tlsDaysRemaining,
        at: new Date(now),
      })),
    });
  } catch (err) {
    // A prober that crashes the worker because the database is down is a
    // prober that goes silent for the outage it exists to record. The results
    // are still returned to the caller.
    logger.warn({ err }, "synthetic_store_failed");
  }
  const down = results.filter((r) => !r.ok);
  if (down.length > 0) {
    logger.warn({ down: down.map((d) => ({ target: d.target, status: d.statusCode, error: d.error })) }, "synthetic_check_failed");
  }
  return results;
}

/**
 * Run on a timer.
 *
 * A plain interval in the worker, same argument as the alert evaluator: this is
 * the check that has to keep working when the queue does not.
 *
 * SIXTY SECONDS. Five targets a minute is 7,200 requests a day against our own
 * hosts, which is nothing, and it bounds how long the product can be down
 * before there is a record of it. Retention prunes the table at thirty days
 * alongside the other observability tables.
 */
const INTERVAL_MS = 60_000;
let timer: NodeJS.Timeout | null = null;

export function startSyntheticProber(intervalMs = INTERVAL_MS): void {
  if (timer) return;
  const tick = () => {
    void runSyntheticChecks().catch((err: unknown) => logger.error({ err }, "synthetic_probe_failed"));
  };
  // Not immediately. On a deploy this process starts before Caddy has finished
  // swinging traffic to the new containers, and a probe fired into that window
  // records an outage that is really a rolling restart.
  timer = setTimeout(() => {
    tick();
    timer = setInterval(tick, intervalMs);
    timer.unref();
  }, 30_000);
  timer.unref();
}

export function stopSyntheticProber(): void {
  if (!timer) return;
  clearInterval(timer);
  clearTimeout(timer);
  timer = null;
}
