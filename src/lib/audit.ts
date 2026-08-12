import { prisma } from "./prisma.js";
import { logger } from "./logger.js";
import type { ActorType } from "@prisma/client";

// §29 audit trail. Before this, only reconciliation write-off/restore wrote
// here — every other mutation of consequence (a connected credential, an
// imported statement, a bulk cost change, an org rename) left no record of
// who did it or when. `writeAudit` is the one call site every route below
// uses, so the shape can never drift between them.
//
// Never throws into the caller: an audit-log failure must not fail the
// mutation it is describing — losing the "who" is bad, losing the "what
// happened to the money" is worse. Logged at error level so it still surfaces.
export async function writeAudit(entry: {
  organizationId: string;
  actorType: ActorType;
  actorId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  try {
    await prisma.auditLog.create({
      data: {
        organizationId: entry.organizationId,
        actorType: entry.actorType,
        actorId: entry.actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        metadata: entry.metadata as never,
      },
    });
  } catch (err) {
    logger.error({ err, action: entry.action }, "audit_write_failed");
  }
}
