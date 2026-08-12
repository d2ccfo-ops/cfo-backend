import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import { ensureDemoNamePrefix, findDemoOrg } from "./lib/demoOrg.js";

// Compares every generated row against the REAL rows already in this database,
// column by column, and reports where the two disagree in shape.
//
// The question this answers is not "does the demo look plausible" — it is
// "when a real Shopify/Razorpay/Shiprocket connection is made later, will any
// code path that works on demo data break on real data, or vice versa". Those
// are the failures that cost days, because they surface long after the seed is
// forgotten and they look like connector bugs.
//
// Three classes of mismatch, in descending severity:
//
//   BREAKING  a column real data always fills that the demo leaves null (or the
//             reverse) — downstream code written against one will throw on the
//             other. Also any value outside the set real data uses, where the
//             consuming code switches on it.
//   DRIFT     format differences that parse fine but read wrong: an id that
//             does not look like the vendor's, a status string nobody emits.
//   NOTE      differences that are correct and intended, recorded so a future
//             reader does not "fix" them.
//
// Run with: npx tsx scripts/checkDemoRealism.ts

let breaking = 0;
let drift = 0;
const issues: string[] = [];

function report(level: "BREAKING" | "DRIFT" | "NOTE", where: string, detail: string) {
  if (level === "BREAKING") breaking += 1;
  if (level === "DRIFT") drift += 1;
  const line = `  ${level.padEnd(8)} ${where.padEnd(34)} ${detail}`;
  if (level !== "NOTE") issues.push(line);
  console.log(line);
}

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);

// Differences that are correct and deliberate. Recorded with a reason so they
// stop costing a re-investigation on every run, and so a future reader does not
// "fix" one back into a bug.
const INTENDED: Record<string, string> = {
  "line_items.cogsAmount":
    "the demo costs every SKU on purpose — the backend needs 100% line coverage before CM0 is reliable (contribution.ts: uncostedLines === 0), so a partial-coverage seed would leave contribution margin permanently unmeasurable. `seedDemoData.ts --cost-gaps` is the run that deliberately breaks it.",
  "payments.feeAmount":
    "real payments here come from Shopify transactions, which carry no gateway fee; the demo's come from Razorpay, which does. Filling a column real data lacks is additive, never breaking.",
};

// A column that is always present on one side and never on the other is the
// shape that breaks code. Within a few points of each other is fine — real data
// is messy and the demo should be too.
function compareNullRate(table: string, column: string, realNull: number, realTotal: number, demoNull: number, demoTotal: number) {
  const r = pct(realNull, realTotal);
  const d = pct(demoNull, demoTotal);
  const where = `${table}.${column}`;
  const detail = `real ${r}% null · demo ${d}% null`;
  const intended = INTENDED[where];
  if (intended) return report("NOTE", where, `${detail} — intended: ${intended}`);
  if (r === 100 && d < 100) return report("NOTE", where, `${detail} (demo fills a column real data never has — safe)`);
  if (r < 5 && d > 95) return report("BREAKING", where, `${detail} — code written against real data will read null on demo`);
  if (r > 95 && d < 5) return report("BREAKING", where, `${detail} — code written against demo will read null on real`);
  if (Math.abs(r - d) > 40) return report("DRIFT", where, detail);
  return report("NOTE", where, detail);
}

// Null counts for many columns in one pass. Raw SQL because Prisma's `where`
// rejects `column: null` for a non-nullable column at the type AND runtime
// level — but "does this column ever hold null" is precisely what has to be
// compared, and the answer for a NOT NULL column is a legitimate zero.
async function nullRates(table: string, columns: string[], organizationId: string, orderScoped = false) {
  const cols = columns
    .map((c) => Prisma.sql`count(*) FILTER (WHERE t.${Prisma.raw(`"${c}"`)} IS NULL) AS ${Prisma.raw(`"${c}"`)}`)
    .reduce((a, b) => Prisma.sql`${a}, ${b}`);
  const from = orderScoped
    ? Prisma.sql`FROM order_line_items t JOIN orders o ON o.id = t."orderId" WHERE o."organizationId" = ${organizationId}`
    : Prisma.sql`FROM ${Prisma.raw(table)} t WHERE t."organizationId" = ${organizationId}`;
  const rows = await prisma.$queryRaw<Record<string, bigint>[]>`SELECT count(*) AS total, ${cols} ${from}`;
  const row = rows[0]!;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(row)) out[k] = Number(v);
  return out;
}

// The CONTRACT for a column is what the connectors can emit — read out of the
// connector source, or the Prisma enum — not what one store happened to
// produce. Comparing against observed real values alone flagged RTO_DELIVERED
// as invalid purely because this particular Shopify store has had no returns
// come all the way back, which is a fact about the store, not the schema.
const ALLOWED: Record<string, { values: string[]; source: string }> = {
  "orders.channel": {
    values: ["shopify", "amazon", "flipkart"],
    source: "hard-coded in shopify/amazon/flipkart connectors",
  },
  "orders.status": {
    // Shopify financial_status. shopify/index.ts falls back to
    // fulfillment_status and then "unknown", so those are legal too.
    values: ["pending", "authorized", "partially_paid", "paid", "partially_refunded", "refunded", "voided", "unknown", "fulfilled", "unfulfilled", "restocked"],
    source: "Shopify financial_status, via mapOrder()",
  },
  "orders.paymentMode": { values: ["COD", "PREPAID", "UNKNOWN"], source: "classifyPaymentMode()" },
  "orders.currency": { values: ["INR"], source: "Indian D2C" },
  "shipments.status": {
    values: ["NEW", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "RTO_INITIATED", "RTO_DELIVERED", "CANCELLED", "LOST", "UNKNOWN"],
    source: "ShipmentStatus enum / shiprocket STATUS_MAP",
  },
  "payments.status": {
    values: ["created", "authorized", "captured", "refunded", "failed"],
    source: "Razorpay payment status",
  },
};

function compareSets(table: string, column: string, real: string[], demo: string[]) {
  const where = `${table}.${column}`;
  const realSet = new Set(real);
  const demoSet = new Set(demo);
  const contract = ALLOWED[where];

  if (contract) {
    const illegalDemo = [...demoSet].filter((v) => !contract.values.includes(v));
    const illegalReal = [...realSet].filter((v) => !contract.values.includes(v));
    if (illegalDemo.length > 0) {
      report("BREAKING", where, `demo emits values no connector can produce: ${illegalDemo.join(", ")} (contract: ${contract.source})`);
    }
    if (illegalReal.length > 0) {
      report("DRIFT", where, `REAL data holds values outside the recorded contract: ${illegalReal.join(", ")} — the contract list is wrong, not the data`);
    }
    const unexercised = contract.values.filter((v) => !demoSet.has(v) && realSet.has(v));
    if (unexercised.length > 0) {
      report("DRIFT", where, `legal values the demo never produces but real data does: ${unexercised.join(", ")}`);
    }
    if (illegalDemo.length === 0 && illegalReal.length === 0 && unexercised.length === 0) {
      report("NOTE", where, `demo {${[...demoSet].join(", ")}} ⊆ contract, and covers everything real data shows`);
    }
    return;
  }

  const onlyDemo = [...demoSet].filter((v) => !realSet.has(v));
  if (onlyDemo.length > 0) report("DRIFT", where, `demo-only values (no recorded contract): ${onlyDemo.join(", ")}`);
  else report("NOTE", where, `demo values all appear in real data`);
}

async function main() {
  const demoOrg = await findDemoOrg();
  if (!demoOrg) {
    console.log("no demo organisation — run scripts/seedDemoData.ts first");
    process.exit(1);
  }
  await ensureDemoNamePrefix(demoOrg);
  // The largest real org, used as the reference shape.
  const realCounts = await prisma.order.groupBy({
    by: ["organizationId"],
    _count: { _all: true },
    where: { organizationId: { not: demoOrg.id } },
    orderBy: { _count: { organizationId: "desc" } },
    take: 1,
  });
  if (realCounts.length === 0) {
    console.log("no real orders to compare against");
    process.exit(1);
  }
  const realOrgId = realCounts[0]!.organizationId;
  const realOrg = await prisma.organization.findUnique({ where: { id: realOrgId }, select: { name: true } });
  console.log(`\nreference (real): ${realOrg?.name}   subject (demo): ${demoOrg.name}\n`);

  // -------------------------------------------------------------------------
  console.log("[orders] column presence");
  const orderCols = [
    "orderNumber", "channel", "status", "currency", "paymentMode", "customerRef", "raw",
    "cancelledAt", "discountAmount", "taxAmount", "itemsAmount", "shippingAmount", "refundedAmount",
  ] as const;
  const [realOrders, demoOrders] = await Promise.all([
    nullRates("orders", [...orderCols], realOrgId),
    nullRates("orders", [...orderCols], demoOrg.id),
  ]);
  for (const col of orderCols) {
    compareNullRate("orders", col, realOrders[col]!, realOrders.total!, demoOrders[col]!, demoOrders.total!);
  }

  console.log("\n[orders] value domains");
  for (const col of ["status", "channel", "paymentMode", "currency"] as const) {
    const [r, d] = await Promise.all([
      prisma.order.groupBy({ by: [col], where: { organizationId: realOrgId }, _count: { _all: true } }),
      prisma.order.groupBy({ by: [col], where: { organizationId: demoOrg.id }, _count: { _all: true } }),
    ]);
    compareSets("orders", col, r.map((x) => String(x[col])), d.map((x) => String(x[col])));
  }

  // -------------------------------------------------------------------------
  console.log("\n[orders] raw payload keys");
  const [realRaw, demoRaw] = await Promise.all([
    prisma.$queryRaw<{ key: string; n: bigint }[]>`
      SELECT k AS key, count(*) AS n FROM orders o, LATERAL jsonb_object_keys(o.raw) k
      WHERE o."organizationId" = ${realOrgId} AND o.raw IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`,
    prisma.$queryRaw<{ key: string; n: bigint }[]>`
      SELECT k AS key, count(*) AS n FROM orders o, LATERAL jsonb_object_keys(o.raw) k
      WHERE o."organizationId" = ${demoOrg.id} AND o.raw IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`,
  ]);
  const realKeys = new Set(realRaw.map((r) => r.key));
  const demoKeys = new Set(demoRaw.map((r) => r.key));
  console.log(`  real raw has ${realKeys.size} distinct keys · demo has ${demoKeys.size}`);
  const inventedKeys = [...demoKeys].filter((k) => !realKeys.has(k));
  if (inventedKeys.length > 0) {
    report("BREAKING", "orders.raw", `demo invents keys Shopify never sends: ${inventedKeys.join(", ")}`);
  } else {
    report("NOTE", "orders.raw", "every demo key exists in real Shopify payloads");
  }
  // The keys the application actually reads out of raw — these are the ones
  // whose absence changes behaviour rather than just looking thin.
  const READ_FROM_RAW = ["payment_terms", "source_name", "user_id", "email", "confirmation_number", "total_outstanding", "tags", "customer"];
  const missing = READ_FROM_RAW.filter((k) => realKeys.has(k) && !demoKeys.has(k));
  if (missing.length > 0) {
    report("DRIFT", "orders.raw", `keys the app reads that the demo omits: ${missing.join(", ")}`);
  }

  // -------------------------------------------------------------------------
  console.log("\n[order_line_items] column presence");
  const liCols = ["sku", "cogsAmount", "discountAmount", "taxAmount", "refundedAmount", "refundedTaxAmount", "refundedQuantity"];
  const [realLi, demoLi] = await Promise.all([
    nullRates("order_line_items", liCols, realOrgId, true),
    nullRates("order_line_items", liCols, demoOrg.id, true),
  ]);
  for (const col of liCols) {
    compareNullRate("line_items", col, realLi[col]!, realLi.total!, demoLi[col]!, demoLi.total!);
  }

  // -------------------------------------------------------------------------
  console.log("\n[shipments]");
  const [rShipTotal, dShipTotal] = await Promise.all([
    prisma.shipment.count({ where: { organizationId: realOrgId } }),
    prisma.shipment.count({ where: { organizationId: demoOrg.id } }),
  ]);
  if (rShipTotal === 0) {
    report("NOTE", "shipments", "no real shipments to compare against — verified against connector code instead");
  } else {
    // deliveredAt is deliberately NOT compared as a flat null rate. It is null
    // exactly when the status is not DELIVERED, in both datasets — the rates
    // differ only because 64% of the real store's shipments are stuck at
    // PICKED_UP and never progressed, which is a fact about that store's
    // courier feed, not a shape mismatch. The invariant is checked below
    // instead, which is what any consuming code actually relies on.
    const shipCols = ["orderId", "awbCode", "courierName", "codAmount", "pickedUpAt", "freightAmount", "raw"];
    const [realShip, demoShip] = await Promise.all([
      nullRates("shipments", shipCols, realOrgId),
      nullRates("shipments", shipCols, demoOrg.id),
    ]);
    for (const col of shipCols) compareNullRate("shipments", col, realShip[col]!, rShipTotal, demoShip[col]!, dShipTotal);
    // The invariant, on both sides: a delivered shipment always carries a
    // delivery timestamp, and a non-delivered one never does.
    for (const [label, orgId] of [["real", realOrgId], ["demo", demoOrg.id]] as const) {
      const bad = await prisma.$queryRaw<{ delivered_no_ts: bigint; ts_not_delivered: bigint }[]>`
        SELECT
          count(*) FILTER (WHERE status = 'DELIVERED' AND "deliveredAt" IS NULL) AS delivered_no_ts,
          count(*) FILTER (WHERE status <> 'DELIVERED' AND "deliveredAt" IS NOT NULL) AS ts_not_delivered
        FROM shipments WHERE "organizationId" = ${orgId}`;
      const b = bad[0]!;
      const clean = Number(b.delivered_no_ts) === 0 && Number(b.ts_not_delivered) === 0;
      report(clean ? "NOTE" : "BREAKING", `shipments.deliveredAt (${label})`,
        clean ? "holds: deliveredAt is set iff status = DELIVERED"
              : `${b.delivered_no_ts} delivered without a timestamp, ${b.ts_not_delivered} timestamped but not delivered`);
    }

    const [rs, ds] = await Promise.all([
      prisma.shipment.groupBy({ by: ["status"], where: { organizationId: realOrgId }, _count: { _all: true } }),
      prisma.shipment.groupBy({ by: ["status"], where: { organizationId: demoOrg.id }, _count: { _all: true } }),
    ]);
    compareSets("shipments", "status", rs.map((x) => x.status), ds.map((x) => x.status));
  }

  // -------------------------------------------------------------------------
  console.log("\n[payments]");
  const [rPayTotal, dPayTotal] = await Promise.all([
    prisma.payment.count({ where: { organizationId: realOrgId } }),
    prisma.payment.count({ where: { organizationId: demoOrg.id } }),
  ]);
  if (rPayTotal === 0) {
    report("NOTE", "payments", "no real payments to compare against — verified against connector code instead");
  } else {
    const payCols = ["orderId", "method", "feeAmount", "capturedAt", "raw"];
    const [realPay, demoPay] = await Promise.all([
      nullRates("payments", payCols, realOrgId),
      nullRates("payments", payCols, demoOrg.id),
    ]);
    for (const col of payCols) compareNullRate("payments", col, realPay[col]!, rPayTotal, demoPay[col]!, dPayTotal);
    const [rp, dp] = await Promise.all([
      prisma.payment.groupBy({ by: ["status"], where: { organizationId: realOrgId }, _count: { _all: true } }),
      prisma.payment.groupBy({ by: ["status"], where: { organizationId: demoOrg.id }, _count: { _all: true } }),
    ]);
    compareSets("payments", "status", rp.map((x) => x.status), dp.map((x) => x.status));
  }

  // -------------------------------------------------------------------------
  console.log("\n[bank_transactions]");
  const rBank = await prisma.bankTransaction.count({ where: { organizationId: realOrgId } });
  if (rBank === 0) {
    const anyRealBank = await prisma.bankTransaction.findFirst({
      where: { organizationId: { not: demoOrg.id } },
      select: { organizationId: true },
    });
    report("NOTE", "bank_transactions", anyRealBank ? "real rows exist in another org" : "no real rows to compare against");
  }

  // -------------------------------------------------------------------------
  // Identifier formats. These never throw — they mislead, which is worse in a
  // demo somebody screenshots.
  console.log("\n[identifier formats]");
  const sample = async (table: "order" | "payment" | "shipment", field: string, orgId: string) => {
    const rows = await (prisma[table] as { findMany: (a: unknown) => Promise<Record<string, unknown>[]> }).findMany({
      where: { organizationId: orgId },
      select: { [field]: true },
      take: 3,
    });
    return rows.map((r) => String(r[field]));
  };
  for (const [table, field] of [["order", "externalOrderId"], ["order", "orderNumber"], ["payment", "externalPaymentId"], ["shipment", "awbCode"]] as const) {
    const [r, d] = await Promise.all([sample(table, field, realOrgId), sample(table, field, demoOrg.id)]);
    if (r.length === 0 || d.length === 0) continue;
    console.log(`  ${`${table}.${field}`.padEnd(34)} real ${r.join(", ")}  ·  demo ${d.join(", ")}`);
  }

  // -------------------------------------------------------------------------
  // Uniqueness: the one thing that would actually throw at insert time when a
  // real connector later writes into the same org.
  console.log("\n[collision safety]");
  const dupes = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM (
      SELECT "connectionId", "externalOrderId" FROM orders
      GROUP BY 1, 2 HAVING count(*) > 1
    ) t`;
  report(Number(dupes[0]!.n) === 0 ? "NOTE" : "BREAKING", "orders unique key", `${dupes[0]!.n} duplicate (connectionId, externalOrderId) pairs`);

  const sharedConn = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM orders o
    JOIN connections c ON c.id = o."connectionId"
    WHERE o."externalOrderId" LIKE 'demo-%' AND c."credentialsRef" NOT LIKE 'demo-seed:%'`;
  report(Number(sharedConn[0]!.n) === 0 ? "NOTE" : "BREAKING", "demo rows on real connections", `${sharedConn[0]!.n} rows`);

  // A real connector connecting into the demo org would create its OWN
  // connection row, so the unique key is scoped away from the demo's. Verified
  // rather than assumed, because it is the whole reason this is safe.
  const demoConnIds = (
    await prisma.connection.findMany({ where: { credentialsRef: { startsWith: "demo-seed:" } }, select: { id: true, provider: true } })
  );
  report("NOTE", "demo connection scoping", `${demoConnIds.length} demo connections; unique keys are (connectionId, externalId) so a real connector gets its own namespace`);

  console.log(`\n${"─".repeat(78)}`);
  console.log(`${breaking} breaking, ${drift} drift`);
  if (issues.length > 0) {
    console.log("\nneeds attention:");
    for (const i of issues) console.log(i);
  }
  await prisma.$disconnect();
  process.exit(breaking > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
