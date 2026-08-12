import { prisma } from "../src/lib/prisma.js";
import { runReconciliation } from "../src/modules/calc/reconciliation.js";

// The reconciliation matching passes cannot execute against this database —
// there are zero payments and zero settlements in it, so every leg reports
// "unavailable" and the actual matching code never runs. This builds a
// throwaway organisation with synthetic records, exercises every pass and
// every deliberate NON-match, then destroys it.
//
// Run with: npx tsx scripts/testReconciliationMatching.ts
//
// The org name carries an unmistakable marker and cleanup runs in a finally
// block, so a crash mid-run leaves something obviously identifiable rather
// than plausible-looking fake orders sitting next to real ones.

const MARKER = "__RECON_TEST_FIXTURE__";

const day = (n: number) => new Date(Date.UTC(2026, 6, n, 12, 0, 0));

let passed = 0;
let failed = 0;

const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));

function check(label: string, actual: unknown, expected: unknown) {
  const ok = show(actual) === show(expected);
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}\n      expected ${show(expected)}\n      actual   ${show(actual)}`);
  }
}

async function main() {
  const org = await prisma.organization.create({
    data: { clerkOrgId: `${MARKER}-${Date.now()}`, name: MARKER },
  });
  const entity = await prisma.legalEntity.create({ data: { organizationId: org.id, name: MARKER } });

  const mkConnection = (provider: "SHOPIFY" | "RAZORPAY" | "BANK") =>
    prisma.connection.create({
      data: {
        organizationId: org.id,
        legalEntityId: entity.id,
        provider,
        status: "ACTIVE",
        credentialsRef: MARKER,
        externalAccountId: `${MARKER}-${provider}`,
      },
    });

  try {
    const shopify = await mkConnection("SHOPIFY");
    const razorpay = await mkConnection("RAZORPAY");
    const bank = await mkConnection("BANK");

    const mkOrder = (opts: {
      ref: string;
      amount: bigint;
      placedAt: Date;
      paymentMode?: string;
      cancelledAt?: Date | null;
    }) =>
      prisma.order.create({
        data: {
          organizationId: org.id,
          legalEntityId: entity.id,
          connectionId: shopify.id,
          externalOrderId: opts.ref,
          orderNumber: `#${opts.ref}`,
          channel: "SHOPIFY",
          status: "paid",
          grossAmount: opts.amount,
          itemsAmount: opts.amount,
          placedAt: opts.placedAt,
          paymentMode: opts.paymentMode ?? "PREPAID",
          cancelledAt: opts.cancelledAt ?? null,
        },
      });

    const mkPayment = (opts: { ext: string; amount: bigint; at: Date; notes?: object; orderId?: string }) =>
      prisma.payment.create({
        data: {
          organizationId: org.id,
          legalEntityId: entity.id,
          connectionId: razorpay.id,
          externalPaymentId: opts.ext,
          amount: opts.amount,
          status: "captured",
          capturedAt: opts.at,
          orderId: opts.orderId ?? null,
          raw: opts.notes ? ({ notes: opts.notes } as object) : undefined,
        },
      });

    // --- Fixtures ---------------------------------------------------------
    // 1. keyed by the merchant reference inside Razorpay's notes
    const oRef = await mkOrder({ ref: "1001", amount: 245000n, placedAt: day(1) });
    await mkPayment({ ext: "pay_ref", amount: 245000n, at: day(1), notes: { shopify_order_name: "#1001" } });

    // 2. keyed by the Payment.orderId FK
    const oFk = await mkOrder({ ref: "1002", amount: 189000n, placedAt: day(2) });
    await mkPayment({ ext: "pay_fk", amount: 189000n, at: day(2), orderId: oFk.id });

    // 3. keyed, but the amounts disagree by more than the ₹1 tolerance
    const oShort = await mkOrder({ ref: "1003", amount: 312000n, placedAt: day(3) });
    await mkPayment({ ext: "pay_short", amount: 297000n, at: day(3), notes: { order: "#1003" } });

    // 4. no key — resolvable only on exact amount inside the date window
    const oAmt = await mkOrder({ ref: "1004", amount: 96000n, placedAt: day(4) });
    await mkPayment({ ext: "pay_amt", amount: 96000n, at: day(5) });

    // 5. amount matches but the payment is 10 days away — outside the window
    await mkOrder({ ref: "1005", amount: 77700n, placedAt: day(4) });
    await mkPayment({ ext: "pay_far", amount: 77700n, at: day(20) });

    // 6. AMBIGUOUS: two orders and two payments all of the same value on the
    //    same day. A machine cannot tell which pairs with which, so it must
    //    pair NONE of them rather than guess.
    await mkOrder({ ref: "1006a", amount: 50000n, placedAt: day(6) });
    await mkOrder({ ref: "1006b", amount: 50000n, placedAt: day(6) });
    await mkPayment({ ext: "pay_amb1", amount: 50000n, at: day(6) });
    await mkPayment({ ext: "pay_amb2", amount: 50000n, at: day(6) });

    // 7. COD order with a same-value payment sitting right there. Must NOT be
    //    counted as eligible and must NOT consume that payment.
    await mkOrder({ ref: "1007", amount: 133000n, placedAt: day(7), paymentMode: "COD" });

    // 8. cancelled order — no payment is expected, so it is not a failure
    await mkOrder({ ref: "1008", amount: 210000n, placedAt: day(8), cancelledAt: day(9) });

    // 8b. THE TRAP the Shopify transactions pull makes real: a COD order
    //     "marked as paid" gets a payment row carrying that order's FK, with
    //     the same value and day as order 1005 (₹777, day 4), which has no
    //     payment of its own. The FK points at an INELIGIBLE order, so the
    //     engine must consume this payment silently — if it leaks into the
    //     amount-and-date pool it would "find" order 1005's missing payment.
    const oCodTrap = await mkOrder({ ref: "1009", amount: 77700n, placedAt: day(4), paymentMode: "COD" });
    const pCodTrap = await mkPayment({ ext: "pay_cod_trap", amount: 77700n, at: day(4), orderId: oCodTrap.id });

    // --- Settlements and bank credits ------------------------------------
    const mkSettlement = (ext: string, amount: bigint, utr: string | null, at: Date) =>
      prisma.settlement.create({
        data: {
          organizationId: org.id,
          legalEntityId: entity.id,
          connectionId: razorpay.id,
          externalSettlementId: ext,
          amount,
          utr,
          status: "processed",
          settledAt: at,
        },
      });

    const mkCredit = (ext: string, amount: bigint, utr: string | null, at: Date, description?: string) =>
      prisma.bankTransaction.create({
        data: {
          organizationId: org.id,
          legalEntityId: entity.id,
          connectionId: bank.id,
          externalTxnId: ext,
          amount,
          direction: "CREDIT",
          valueDate: at,
          utr,
          description: description ?? null,
        },
      });

    // 9. UTR present on both sides
    await mkSettlement("setl_utr", 900000n, "UTR123456789", day(10));
    await mkCredit("bank_utr", 900000n, "UTR123456789", day(10));

    // 10. UTR only in the bank narration, not as a field
    await mkSettlement("setl_buried", 450000n, "UTR987654321", day(11));
    await mkCredit("bank_buried", 450000n, null, day(11), "NEFT CR/UTR987654321/RAZORPAY SETTLEMENT");

    // 11. no UTR anywhere — falls back to exact amount inside the window
    await mkSettlement("setl_amt", 275000n, null, day(12));
    await mkCredit("bank_amt", 275000n, null, day(13));

    // 12. a debit of the same value must never be matched as an inflow
    await mkSettlement("setl_debit", 610000n, null, day(14));
    await prisma.bankTransaction.create({
      data: {
        organizationId: org.id,
        legalEntityId: entity.id,
        connectionId: bank.id,
        externalTxnId: "bank_debit",
        amount: 610000n,
        direction: "DEBIT",
        valueDate: day(14),
      },
    });

    // --- Run --------------------------------------------------------------
    console.log("\nRun 1");
    const first = await runReconciliation(org.id);
    const orderLeg = first.legs.find((l) => l.matchType === "ORDER_PAYMENT")!;
    const bankLeg = first.legs.find((l) => l.matchType === "SETTLEMENT_BANK")!;

    check("ORDER_PAYMENT leg ran", orderLeg.state, "ran");
    // eligible = prepaid, not cancelled: 1001-1005, 1006a, 1006b  → 7
    check("eligible excludes COD and cancelled", orderLeg.eligible, 7);
    // matched = 1001 (notes), 1002 (fk), 1003 (notes, short), 1004 (amount)
    check("matched count", orderLeg.matched, 4);
    check("short payment flagged for review", orderLeg.needsReview, 1);
    check("ambiguous pair left unmatched", orderLeg.unmatched, 3);

    const matches = await prisma.reconciliationMatch.findMany({
      where: { organizationId: org.id, matchType: "ORDER_PAYMENT" },
      select: { sourceId: true, confidence: true, amountDeltaAbs: true },
    });
    const bySource = new Map(matches.map((m) => [m.sourceId, m]));
    check("notes-keyed match is HIGH", bySource.get(oRef.id)?.confidence, "HIGH");
    check("FK-keyed match is HIGH", bySource.get(oFk.id)?.confidence, "HIGH");
    check("amount-only match is MEDIUM", bySource.get(oAmt.id)?.confidence, "MEDIUM");
    check("short payment delta recorded", bySource.get(oShort.id)?.amountDeltaAbs, 15000n);

    // The COD-trap payment must have been consumed silently: no match row
    // targets it, and order 1005 (same amount, same day) stays unmatched.
    const trapMatch = await prisma.reconciliationMatch.findFirst({
      where: { organizationId: org.id, targetId: pCodTrap.id },
      select: { id: true },
    });
    check("COD order's own payment never amount-matches another order", trapMatch, null);
    const o1005 = await prisma.order.findFirst({
      where: { organizationId: org.id, externalOrderId: "1005" },
      select: { id: true },
    });
    const o1005Match = await prisma.reconciliationMatch.findFirst({
      where: { organizationId: org.id, sourceId: o1005!.id },
      select: { id: true },
    });
    check("order 1005 stays unmatched despite the trap", o1005Match, null);

    check("SETTLEMENT_BANK leg ran", bankLeg.state, "ran");
    check("settlements matched", bankLeg.matched, 3);
    check("debit-only settlement unmatched", bankLeg.unmatched, 1);

    const bankMatches = await prisma.reconciliationMatch.findMany({
      where: { organizationId: org.id, matchType: "SETTLEMENT_BANK" },
      select: { confidence: true },
    });
    const confCounts = bankMatches.reduce<Record<string, number>>((acc, m) => {
      acc[m.confidence] = (acc[m.confidence] ?? 0) + 1;
      return acc;
    }, {});
    check("two UTR matches are HIGH, one amount match MEDIUM", confCounts, { HIGH: 2, MEDIUM: 1 });

    // --- Idempotency ------------------------------------------------------
    console.log("\nRun 2 (idempotency)");
    const before = await prisma.reconciliationMatch.count({ where: { organizationId: org.id } });
    const second = await runReconciliation(org.id);
    const after = await prisma.reconciliationMatch.count({ where: { organizationId: org.id } });
    check("re-run creates no new rows", second.created, 0);
    check("row count unchanged", after, before);

    const orderLeg2 = second.legs.find((l) => l.matchType === "ORDER_PAYMENT")!;
    check("re-run reports the same matched count", orderLeg2.matched, orderLeg.matched);
    check("re-run reports the same review count", orderLeg2.needsReview, orderLeg.needsReview);
  } finally {
    // Ordered by FK dependency. Anything left behind here would be fake
    // financial data sitting in the same tables as the real store.
    await prisma.reconciliationMatch.deleteMany({ where: { organizationId: org.id } });
    await prisma.bankTransaction.deleteMany({ where: { organizationId: org.id } });
    await prisma.settlement.deleteMany({ where: { organizationId: org.id } });
    await prisma.payment.deleteMany({ where: { organizationId: org.id } });
    await prisma.orderLineItem.deleteMany({ where: { order: { organizationId: org.id } } });
    await prisma.order.deleteMany({ where: { organizationId: org.id } });
    await prisma.connection.deleteMany({ where: { organizationId: org.id } });
    await prisma.legalEntity.deleteMany({ where: { organizationId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
    console.log("\nfixture torn down");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
