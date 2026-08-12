// §68 prepaid vs COD. Matched against the gateway names this store actually
// returns — "Cash on Delivery (COD)", "cash_on_delivery" and GoKwik's "PPCOD"
// (partial-prepaid COD).
//
// Two tests, DIFFERENT semantics, and the difference is money:
//
//  - Classifying an ORDER (classifyPaymentMode): PPCOD counts as COD. A
//    balance is still collected at the door, so the order carries COD's RTO
//    and remittance risk — the reason paymentMode exists.
//
//  - Classifying a captured PAYMENT (isCashAtDoorGateway): "Gokwik PPCOD" is
//    the ONLINE DEPOSIT — ₹21–51 already received before dispatch. Treating
//    it as cash-at-door made the shipments pass refuse to subtract it from
//    the courier collectible, overstating what ~1,100 PPCOD shipments should
//    hand over. Caught by verification, not by review: the deposit rows all
//    said `method: "Gokwik PPCOD", status: captured` while the refinement
//    count sat at 8 instead of ~1,099. Only money physically handed to the
//    courier ("Cash on Delivery (COD)", "cash_on_delivery") passes this test
//    — note /\bcod\b/i does NOT match "PPCOD" (no word boundary inside it).
//
// Its own module (not index.ts) because shipments.ts needs these too, and a
// connector importing from its own index is a circular import waiting to bite.
const COD_ORDER_PATTERNS = [/cash[\s_]*on[\s_]*delivery/i, /\bcod\b/i, /ppcod/i];
const CASH_AT_DOOR_PATTERNS = [/cash[\s_]*on[\s_]*delivery/i, /\bcod\b/i];

export function isCashAtDoorGateway(gateway: string | null | undefined): boolean {
  if (!gateway) return false;
  return CASH_AT_DOOR_PATTERNS.some((p) => p.test(gateway));
}

export function classifyPaymentMode(gateways: string[] | undefined): string {
  if (!gateways || gateways.length === 0) return "UNKNOWN";
  return gateways.some((g) => COD_ORDER_PATTERNS.some((p) => p.test(g))) ? "COD" : "PREPAID";
}
