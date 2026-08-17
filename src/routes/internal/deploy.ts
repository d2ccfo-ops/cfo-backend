import { getAuth } from "@clerk/express";
import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { lookupUsers } from "../../lib/clerkDirectory.js";

// WHAT IS DEPLOYED, AND ASKING FOR SOMETHING ELSE TO BE.
//
// THIS ROUTER CANNOT DEPLOY ANYTHING. It writes a row saying which tag it would
// like to see running; a root-owned agent on the VM polls that row, validates
// it and applies it. The inversion is the entire security design — the
// privileged process pulls from the unprivileged one — and it is what keeps the
// Docker socket, which is root on the host, out of an internet-facing Express
// app. An RCE here can at worst name a tag among images this project already
// published. It cannot run a command.
//
// Everything about the current state comes from the agent's heartbeat rather
// than from this process, because this process cannot see the host: it does not
// know what .env says, what containers are running, or what tags exist. Asking
// it to guess would produce a page that is confidently wrong after any manual
// change on the box.

export const internalDeployRouter = Router();

/**
 * Services the console may act on, and what each one covers.
 *
 * Hard-coded here AND in the agent. The duplication is deliberate: this list
 * decides what the UI offers, the agent's list decides what actually runs, and
 * the agent must never take a service name from the database and trust it.
 */
const SERVICES: Record<string, { envVar: string; covers: string }> = {
  backend: { envVar: "BACKEND_IMAGE", covers: "api + worker" },
  frontend: { envVar: "FRONTEND_IMAGE", covers: "dashboard.d2ccfo.xyz" },
  marketing: { envVar: "MARKETING_IMAGE", covers: "d2ccfo.xyz" },
  // `internal` is deliberately ABSENT. Rolling the console back removes the
  // page that performs rollbacks — v1 has no /deploy route at all — so the
  // button is a trapdoor: press it and the only way forward is a shell on the
  // VM. It happened on 2026-08-17. Rolling the console back is a real need and
  // stays possible; it is done deliberately from the host, not from inside the
  // thing being replaced.
};

/**
 * Below this backend tag, /internal/deploy does not exist.
 *
 * The same trapdoor one layer down: the deploy API only shipped in v21, so a
 * rollback past it leaves .env correct and the agent alive while this page
 * 404s — which the console renders as an allowlist failure, sending whoever
 * pressed the button looking in entirely the wrong place.
 */
const DEPLOY_API_SINCE = 21;

/**
 * How long before the agent counts as gone.
 *
 * It polls every 60s, so 180 allows two missed beats before the console stops
 * offering the button. A button whose agent is dead is worse than no button:
 * it writes a PENDING row nothing will ever pick up and looks like it worked.
 */
const AGENT_STALE_AFTER_MS = 180_000;

/** Tags only, and only this shape. Never an image reference. */
const TAG_PATTERN = /^v\d{1,6}$/;

interface AgentTags {
  configured?: Record<string, string>;
  running?: Record<string, string>;
  available?: Record<string, string[]>;
}

/** Resolved from Clerk rather than the session JWT — see access.ts on why. */
async function actor(req: Parameters<typeof getAuth>[0]): Promise<{ userId: string; email: string }> {
  const userId = getAuth(req).userId ?? "unknown";
  const entry = userId === "unknown" ? undefined : (await lookupUsers([userId])).get(userId);
  return { userId, email: entry?.email ?? userId };
}

/** Everything the deploy page needs, in one call. */
internalDeployRouter.get("/versions", async (_req, res) => {
  const [state, pending, migration] = await Promise.all([
    prisma.deploymentState.findUnique({ where: { id: "singleton" } }),
    prisma.deploymentRequest.findMany({
      where: { status: { in: ["PENDING", "APPLYING"] } },
      orderBy: { requestedAt: "desc" },
    }),
    prisma.$queryRaw<Array<{ migration_name: string; finished_at: Date | null }>>`
      SELECT migration_name, finished_at
      FROM _prisma_migrations
      WHERE finished_at IS NOT NULL
      ORDER BY finished_at DESC
      LIMIT 1
    `,
  ]);

  const now = Date.now();
  const seenAt = state?.seenAt ?? null;
  const secondsAgo = seenAt === null ? null : Math.round((now - seenAt.getTime()) / 1000);
  const stale = seenAt === null || now - seenAt.getTime() > AGENT_STALE_AFTER_MS;

  const tags = (state?.tags ?? {}) as AgentTags;
  const configured = tags.configured ?? {};
  const running = tags.running ?? {};
  const available = tags.available ?? {};

  const services = Object.entries(SERVICES).map(([service, meta]) => {
    const want = configured[service] ?? null;
    // The running map is keyed by container name; a service can cover more than
    // one (backend covers api and worker), so every container whose image
    // belongs to this service is collected and disagreement is preserved rather
    // than averaged away.
    const containers = Object.entries(running)
      .filter(([, image]) => image.includes(`/${service}:`))
      .map(([name, image]) => ({ container: name, tag: image.split(":").pop() ?? image }));

    const distinct = [...new Set(containers.map((c) => c.tag))];
    return {
      service,
      covers: meta.covers,
      envVar: meta.envVar,
      configuredTag: want,
      containers,
      // TRUE when .env and the containers disagree, or two containers of the
      // same service disagree with each other. Either way something did not
      // restart, and the deploy that appeared to succeed did not.
      drift: want !== null && (distinct.length > 1 || (distinct.length === 1 && distinct[0] !== want)),
      availableTags: available[service] ?? [],
    };
  });

  res.json({
    services,
    agent: {
      host: state?.host ?? null,
      version: state?.agentVersion ?? null,
      seenAt: seenAt?.toISOString() ?? null,
      secondsAgo,
      // The console reads this to decide whether to offer the button at all.
      stale,
      staleAfterSeconds: AGENT_STALE_AFTER_MS / 1000,
    },
    // The schema is the real constraint on how far back a backend can go.
    // Migrations in this project are additive by rule, so older code ignoring a
    // newer table is safe — but the boundary is shown rather than assumed, so
    // whoever presses the button is deciding with it in front of them.
    schema: {
      latestMigration: migration[0]?.migration_name ?? null,
      appliedAt: migration[0]?.finished_at?.toISOString() ?? null,
    },
    pending: pending.map((p) => ({
      id: p.id,
      service: p.service,
      fromTag: p.fromTag,
      toTag: p.toTag,
      status: p.status,
      requestedAt: p.requestedAt.toISOString(),
      requestedByEmail: p.requestedByEmail,
      startedAt: p.startedAt?.toISOString() ?? null,
    })),
  });
});

/** Recent requests, applied or not. The deploy log. */
internalDeployRouter.get("/history", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) > 0 ? Math.trunc(Number(req.query.limit)) : 50, 200);
  const rows = await prisma.deploymentRequest.findMany({
    orderBy: { requestedAt: "desc" },
    take: limit,
  });

  res.json({
    requests: rows.map((r) => ({
      id: r.id,
      service: r.service,
      fromTag: r.fromTag,
      toTag: r.toTag,
      status: r.status,
      requestedAt: r.requestedAt.toISOString(),
      requestedByEmail: r.requestedByEmail,
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
      durationMs:
        r.startedAt && r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
      agentHost: r.agentHost,
      error: r.error,
      // What the post-deploy health gate saw. Kept apart from `error` so a
      // verified deploy and a deploy whose gate was skipped are both legible as
      // successes without either being rendered as a failure.
      note: r.note,
    })),
  });
});

/**
 * Ask for a different tag. Rolling back and rolling forward are the same
 * operation — "roll back" is only a direction, and treating them as two verbs
 * would mean two code paths where one of them is exercised once a year.
 */
internalDeployRouter.post("/request", async (req, res) => {
  const body = req.body as { service?: unknown; toTag?: unknown };
  const service = typeof body.service === "string" ? body.service : "";
  const toTag = typeof body.toTag === "string" ? body.toTag.trim() : "";

  if (service === "internal") {
    // Refused HERE as well as omitted from SERVICES, because a control the UI
    // does not draw is not a control the server has declined to perform.
    res.status(409).json({
      error:
        "The console cannot roll itself back — the page doing it would disappear. On the VM: edit INTERNAL_IMAGE in /opt/cfoos/deploy/.env and run docker compose up -d internal.",
    });
    return;
  }
  if (!(service in SERVICES)) {
    res.status(400).json({ error: `Unknown service. One of: ${Object.keys(SERVICES).join(", ")}.` });
    return;
  }
  if (!TAG_PATTERN.test(toTag)) {
    // The agent enforces this again. Two checks because this one produces a
    // usable message and that one is the one that actually protects the host.
    res.status(400).json({ error: "A tag looks like v20. Nothing else is accepted." });
    return;
  }

  const state = await prisma.deploymentState.findUnique({ where: { id: "singleton" } });
  const seenAt = state?.seenAt ?? null;
  if (seenAt === null || Date.now() - seenAt.getTime() > AGENT_STALE_AFTER_MS) {
    // Refusing to queue work nothing will perform. The alternative is a row
    // that sits PENDING forever behind a UI that said "requested".
    res.status(503).json({
      error: seenAt === null
        ? "The deploy agent has never reported in. Nothing would pick this up."
        : `The deploy agent was last seen ${Math.round((Date.now() - seenAt.getTime()) / 1000)}s ago. Nothing would pick this up.`,
    });
    return;
  }

  const tags = (state?.tags ?? {}) as AgentTags;
  const available = tags.available?.[service] ?? [];
  if (available.length > 0 && !available.includes(toTag)) {
    // Containment, not convenience: the set of deployable tags is the set the
    // agent found in this project's own registry. A tag outside it would fail
    // at the agent anyway, and failing here says why.
    res.status(400).json({ error: `${service}:${toTag} is not in the registry. Available: ${available.slice(0, 12).join(", ")}.` });
    return;
  }

  // The backend floor. Refused rather than warned: a rollback that removes this
  // endpoint cannot be undone through this endpoint, and "are you sure" is not
  // a reasonable thing to ask about a one-way door.
  if (service === "backend" && Number(toTag.slice(1)) < DEPLOY_API_SINCE) {
    res.status(409).json({
      error: `backend:${toTag} predates the deploy API (v${DEPLOY_API_SINCE}), so rolling to it would remove this page and the only way back would be a shell on the VM. Do it deliberately from the host if you mean it.`,
    });
    return;
  }

  const fromTag = tags.configured?.[service] ?? null;
  if (fromTag === toTag) {
    res.status(409).json({ error: `${service} is already configured to run ${toTag}.` });
    return;
  }

  const a = await actor(req);

  // One in-flight request per service. Superseding rather than queueing: two
  // pending rollbacks of the same service are a person clicking twice, and
  // applying both in order would restart the service needlessly and land on
  // whichever was clicked first.
  const [, created] = await prisma.$transaction([
    prisma.deploymentRequest.updateMany({
      where: { service, status: "PENDING" },
      data: { status: "SUPERSEDED", finishedAt: new Date() },
    }),
    prisma.deploymentRequest.create({
      data: {
        service,
        fromTag,
        toTag,
        requestedByUserId: a.userId,
        requestedByEmail: a.email,
      },
    }),
  ]);

  logger.warn(
    { actorUserId: a.userId, actorEmail: a.email, service, fromTag, toTag, requestId: created.id },
    "internal_console_deploy_requested",
  );
  res.status(201).json({
    id: created.id,
    service,
    fromTag,
    toTag,
    status: created.status,
    // The agent polls on an interval; nothing happens the instant this returns.
    // Said plainly so the console can show "queued" rather than "deployed".
    pickedUpWithinSeconds: 60,
  });
});
