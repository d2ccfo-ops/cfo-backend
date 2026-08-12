import type { MetricConfidence, MetricGranularity } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

// The find-then-update-or-create dance below is written out longhand in
// revenue.ts, cash.ts and inventory.ts already. It can't be a plain
// .upsert(): Prisma's compound-unique input type requires legalEntityId to
// be a non-null string even though the column is nullable, because SQL NULL
// doesn't participate in uniqueness the way a value does.
//
// Extracted here so new metrics stop copying it a fourth time. The three
// existing callers are deliberately left alone — they work, they're tested
// against real data, and rewriting them to route through this would be
// churn on the one part of the metrics layer that's actually proven.
export async function persistSnapshot(params: {
  organizationId: string;
  metricKey: string;
  periodStart: Date;
  periodEnd: Date;
  valueMinor: bigint;
  formulaVersion: string;
  // Taken from the Prisma-generated enums rather than spelled out as string
  // unions here — a hand-written union silently drifts from schema.prisma the
  // moment someone adds or renames a member.
  granularity?: MetricGranularity;
  confidence?: MetricConfidence;
}) {
  const granularity = params.granularity ?? "MONTHLY";
  const existing = await prisma.metricSnapshot.findFirst({
    where: {
      organizationId: params.organizationId,
      legalEntityId: null,
      metricKey: params.metricKey,
      granularity,
      periodStart: params.periodStart,
      formulaVersion: params.formulaVersion,
    },
    select: { id: true },
  });

  if (existing) {
    await prisma.metricSnapshot.update({
      where: { id: existing.id },
      data: { periodEnd: params.periodEnd, valueMinor: params.valueMinor, computedAt: new Date() },
    });
    return;
  }

  await prisma.metricSnapshot.create({
    data: {
      organizationId: params.organizationId,
      metricKey: params.metricKey,
      granularity,
      periodStart: params.periodStart,
      periodEnd: params.periodEnd,
      valueMinor: params.valueMinor,
      formulaVersion: params.formulaVersion,
      confidence: params.confidence ?? "ESTIMATED",
    },
  });
}
