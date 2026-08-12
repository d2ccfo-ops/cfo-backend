import { Router } from "express";
import type { AnomalySeverity, AnomalyStatus, AnomalyType } from "@prisma/client";
import { z } from "zod";
import { writeAudit } from "../lib/audit.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { runAnomalyRules } from "../modules/calc/anomalies.js";

// §17 anomaly engine, read/write side. The detection itself lives in
// modules/calc/anomalies.ts — nothing here decides whether something is an
// anomaly, same separation every other route in this codebase keeps between
// the calc engine and the transport layer.

export const anomaliesRouter = Router();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Serialised the same way for every endpoint below, so the Exceptions page
// never has to know which route a row came from. `evidence` passes through
// as-is: it is rule-specific by design, and flattening it into named columns
// would mean a schema change per new rule.
//
// Exported so scripts/checkAnomaliesContract.ts can feed the REAL wire shape
// to the frontend's mapper instead of a hand-written lookalike that would
// drift from this the moment a field changes.
export function serializeAnomaly(a: {
  id: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  observedValue: number;
  expectedValue: number;
  difference: number;
  periodStart: Date;
  periodEnd: Date;
  evidence: unknown;
  recommendedInvestigation: string;
  ownerId: string | null;
  status: AnomalyStatus;
  dedupeKey: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: a.id,
    type: a.type,
    severity: a.severity,
    observedValue: a.observedValue,
    expectedValue: a.expectedValue,
    difference: a.difference,
    periodStart: a.periodStart.toISOString(),
    periodEnd: a.periodEnd.toISOString(),
    evidence: a.evidence,
    recommendedInvestigation: a.recommendedInvestigation,
    ownerId: a.ownerId,
    status: a.status,
    dedupeKey: a.dedupeKey,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// GET /anomalies
// ---------------------------------------------------------------------------
//   ?status=OPEN|ACKNOWLEDGED|RESOLVED|DISMISSED   ?type=<AnomalyType>
//   ?severity=INFO|WARNING|CRITICAL   ?limit=1..200   ?cursor=<opaque>
//
// Defaults to OPEN only. A page whose job is "what needs attention" should
// not open on a list dominated by things already dealt with — resolved and
// dismissed rows stay queryable, but you have to ask for them.
anomaliesRouter.get("/", ...requireAuth, async (req, res) => {
  const organizationId = req.auth!.organizationId;

  const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT) : DEFAULT_LIMIT;

  // `all` is an explicit opt-out rather than "omit the param", so that a
  // client which forgets the filter gets the safe, focused default instead
  // of every anomaly ever recorded.
  const statusParam = typeof req.query.status === "string" ? req.query.status : undefined;
  const status = statusParam === "all" ? undefined : ((statusParam as AnomalyStatus | undefined) ?? "OPEN");
  const type = typeof req.query.type === "string" ? (req.query.type as AnomalyType) : undefined;
  const severity = typeof req.query.severity === "string" ? (req.query.severity as AnomalySeverity) : undefined;
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;

  const rows = await prisma.anomaly.findMany({
    where: {
      organizationId,
      ...(status ? { status } : {}),
      ...(type ? { type } : {}),
      ...(severity ? { severity } : {}),
    },
    // Newest first, and id as the tiebreaker for the same reason
    // routes/audit.ts uses one: a single run writes many rows inside the same
    // millisecond, and createdAt alone would page unstably across them.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // Counts are over the whole org, not the page — the UI's filter chips need
  // to say how many are behind each one before you click it.
  const byStatus = await prisma.anomaly.groupBy({
    by: ["status"],
    where: { organizationId },
    _count: { _all: true },
  });
  const bySeverity = await prisma.anomaly.groupBy({
    by: ["severity"],
    where: { organizationId, status: "OPEN" },
    _count: { _all: true },
  });

  res.json({
    anomalies: page.map(serializeAnomaly),
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
    counts: {
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
      openBySeverity: Object.fromEntries(bySeverity.map((r) => [r.severity, r._count._all])),
    },
  });
});

// ---------------------------------------------------------------------------
// POST /anomalies/run
// ---------------------------------------------------------------------------
// Inline, not queued — same reasoning as POST /reconciliation/run: this
// touches nothing but our own Postgres, so a process hop would add latency
// and a failure mode without buying anything. The nightly sweep
// (modules/queue/anomalyScheduler.ts) calls the same function.
anomaliesRouter.post("/run", ...requireAuth, async (req, res) => {
  const result = await runAnomalyRules(req.auth!.organizationId);
  res.json({
    ranAt: result.ranAt.toISOString(),
    periodStart: result.periodStart.toISOString(),
    periodEnd: result.periodEnd.toISOString(),
    created: result.created,
    updated: result.updated,
    firedTypes: result.candidates.map((c) => c.type),
  });
});

// ---------------------------------------------------------------------------
// PATCH /anomalies/:id
// ---------------------------------------------------------------------------
// Triage: change status, assign an owner, or both.
const patchSchema = z
  .object({
    status: z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED", "DISMISSED"]).optional(),
    // null clears the assignment; omitting the key leaves it alone. Those are
    // different intents and the schema keeps them different.
    ownerId: z.string().min(1).max(255).nullable().optional(),
  })
  .strict()
  .refine((b) => b.status !== undefined || b.ownerId !== undefined, "nothing to update");

anomaliesRouter.patch("/:id", ...requireAuth, async (req, res, next) => {
  let parsed: z.infer<typeof patchSchema>;
  try {
    // Parsed inside try/next(err) rather than thrown from the async body — on
    // Express 4 a throw here would hang the request instead of returning 400.
    // See the explanation in lib/dateRange.ts.
    parsed = patchSchema.parse(req.body);
  } catch (err) {
    next(err);
    return;
  }

  const organizationId = req.auth!.organizationId;
  // findFirst scoped by organizationId, not findUnique by id: an id from
  // another org must 404, not leak that the row exists.
  const existing = await prisma.anomaly.findFirst({
    where: { id: req.params.id, organizationId },
  });
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const updated = await prisma.anomaly.update({
    where: { id: existing.id },
    data: {
      ...(parsed.status !== undefined ? { status: parsed.status } : {}),
      ...(parsed.ownerId !== undefined ? { ownerId: parsed.ownerId } : {}),
    },
  });

  // A human deciding an anomaly is dealt with is a decision about money, and
  // DISMISSED in particular is a decision to stop looking — §29 says those
  // are auditable. Recorded with both sides of the transition so the trail
  // answers "what did they change", not just "they touched it".
  await writeAudit({
    organizationId,
    actorType: "USER",
    actorId: req.auth!.userId,
    action: "anomaly.triaged",
    entityType: "ANOMALY",
    entityId: existing.id,
    metadata: {
      type: existing.type,
      statusFrom: existing.status,
      statusTo: updated.status,
      ownerFrom: existing.ownerId,
      ownerTo: updated.ownerId,
    },
  });

  res.json(serializeAnomaly(updated));
});
