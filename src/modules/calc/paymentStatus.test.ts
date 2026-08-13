import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { CAPTURED_STATUSES, capturedStatusFilter, capturedStatusSql, isCapturedStatus } from "./paymentStatus.js";

// Payment.status is free-text, written by whichever connector ingested the row.
// calc/moneyMovement.ts filtered on "CAPTURED" while every writer stores
// "captured", so it matched zero rows and reported the gateway float as a
// measured ₹0 — an answer the AI tool registry served verbatim.

describe("captured-status predicate", () => {
  it("matches the casing connectors actually write", () => {
    // Shopify inserts the literal 'captured'; Razorpay passes through its own
    // lowercase value. A DB check confirmed 'captured' is the only spelling
    // present across 20,188 rows.
    expect(CAPTURED_STATUSES).toContain("captured");
    expect(isCapturedStatus("captured")).toBe(true);
  });

  it("is case-insensitive across every spelling", () => {
    for (const s of ["captured", "CAPTURED", "Captured", "paid", "PAID", "processed", "settled"]) {
      expect(isCapturedStatus(s), s).toBe(true);
    }
  });

  it("EXCLUDES states where no money moved", () => {
    // The load-bearing half. An authorised payment is a reversible hold and a
    // failed one never moved anything; counting either is how a dashboard shows
    // cash that does not exist. This list must never grow to include them.
    for (const s of ["authorized", "AUTHORIZED", "failed", "refunded", "created", "pending", "cancelled"]) {
      expect(isCapturedStatus(s), s).toBe(false);
    }
    expect(isCapturedStatus(null)).toBe(false);
    expect(isCapturedStatus(undefined)).toBe(false);
    expect(isCapturedStatus("")).toBe(false);
  });

  it("the Prisma filter and the SQL fragment describe the same set", () => {
    const inList = capturedStatusFilter().status.in.map((s) => s.toLowerCase());
    const frag = capturedStatusSql(Prisma.sql`p.status`);
    // The SQL form lowercases the column and compares against the base
    // spellings, so every value the Prisma filter accepts must appear there.
    for (const v of new Set(inList)) {
      expect(frag.values, v).toContain(v);
    }
  });

  it("the SQL fragment parameterises its values rather than interpolating them", () => {
    const frag = capturedStatusSql(Prisma.sql`p.status`);
    expect(frag.sql).toContain("lower(");
    // No literal spellings spliced into the SQL text — they ride as bind params.
    expect(frag.sql).not.toContain("'captured'");
    expect(frag.values.length).toBeGreaterThan(0);
  });
});
