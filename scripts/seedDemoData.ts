/**
 * Generates a complete, self-consistent year of synthetic data for one
 * organisation: Shopify orders and products, Razorpay payments and settlements,
 * Shiprocket shipments, bank transactions, Meta/Google ad spend, vendor bills,
 * expenses and product costs.
 *
 *   npx tsx scripts/seedDemoData.ts --list
 *   npx tsx scripts/seedDemoData.ts --org "Demo Brand"
 *   npx tsx scripts/seedDemoData.ts --org "Demo Brand" --purge
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SAFE, AND THE ONE WAY IT COULD STOP BEING
 * ---------------------------------------------------------------------------
 * This has already gone wrong once in this project. 68 fabricated orders worth
 * ₹1,64,731 sat alongside real ones and counted toward order volume, AOV, gross
 * sales and net revenue for weeks — scripts/purgeSeedFixtures.ts exists solely
 * to clean that up, and it only worked because those rows happened to carry
 * three independent markers. Synthetic data is not dangerous because it is
 * wrong; it is dangerous because once written it is INDISTINGUISHABLE from
 * measured data, and the whole no-invented-numbers discipline in the frontend
 * is defeated the moment the database itself is lying.
 *
 * So:
 *
 *  1. It refuses to run against an organisation that already holds real data.
 *     Not a warning — a refusal. --force exists but prints what it is about to
 *     contaminate first.
 *  2. Every row it writes hangs off a Connection whose `credentialsRef` starts
 *     with "demo-seed:". That is the single marker, it is on the parent, and it
 *     cannot be partially true — so --purge is exact rather than heuristic.
 *  3. The organisation is renamed with a "DEMO — " prefix, which the frontend
 *     surfaces as a persistent banner. If you are looking at fabricated numbers
 *     you should never have to remember that you are.
 *  4. It is deterministic. Same org, same seed, same 6,000 orders — so a bug
 *     found against demo data can be reproduced rather than re-rolled away.
 *
 * The data is shaped to exercise the paths that matter rather than to look
 * pretty: COD-dominant mix, RTO on COD at 16%, partial payments that land in
 * `review`, orders on payment terms that land in `invoiced`, bank visibility
 * that begins seven months in (so the cash line has a genuine gap rather than a
 * false zero), and inventory spread across every cover status. A seed where
 * everything is healthy tests nothing.
 */
import { Prisma, type Provider, type ShipmentStatus } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const LIST = flag("list");
const PURGE = flag("purge");
const FORCE = flag("force");
const MIXED_CURRENCY = flag("mixed-currency");
// The backend marks CM0 unreliable unless EVERY order line is costed — not 95%,
// every one (modules/calc/contribution.ts: `uncostedLines === 0`). So a seed
// with a permanent cost gap would leave contribution margin permanently
// "Not measurable", which hides the headline capability rather than
// demonstrating a guard. Full coverage is the default; --cost-gaps strips one
// SKU's cost to show the guard firing.
const COST_GAPS = flag("cost-gaps");
const ORG_QUERY = value("org");
const MONTHS = Number(value("months") ?? 12);

const DEMO_CREDENTIALS_PREFIX = "demo-seed:";
const DEMO_NAME_PREFIX = "DEMO — ";

// ---------------------------------------------------------------------------
// Deterministic randomness. Math.random() would make every run a different
// dataset, so a number someone reports from the demo could never be looked into.
// ---------------------------------------------------------------------------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260810);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
const between = (lo: number, hi: number) => lo + rnd() * (hi - lo);
const intBetween = (lo: number, hi: number) => Math.floor(between(lo, hi + 1));
const chance = (p: number) => rnd() < p;

// Ids are generated rather than left to cuid() so every table can be written
// with createMany — 6,000 individual creates is minutes, batched is seconds.
let counter = 0;
const id = (prefix: string) => `demo_${prefix}_${(counter++).toString(36)}`;

const DAY = 86_400_000;
const paise = (rupees: number) => BigInt(Math.round(rupees * 100));

// ---------------------------------------------------------------------------
// The catalogue. Prices are ex-GST; GST is added at line level because these
// stores price tax-inclusive (Shopify taxes_included = true), which is what the
// revenue ladder's §10 handling exists for.
// ---------------------------------------------------------------------------
const GST_RATE = 0.18;

interface SeedVariant {
  sku: string;
  title: string;
  priceExGst: number;
  cost: number | null; // null = deliberately uncosted, to exercise coverage
  stock: number;
  weight: number; // relative sales frequency
}
interface SeedProduct {
  title: string;
  type: string;
  variants: SeedVariant[];
}

const CATALOGUE: SeedProduct[] = [
  {
    title: "Vitamin C Face Serum",
    type: "Skincare",
    variants: [
      { sku: "VCS-30", title: "30 ml", priceExGst: 699, cost: 214, stock: 420, weight: 14 },
      { sku: "VCS-50", title: "50 ml", priceExGst: 1099, cost: 331, stock: 190, weight: 7 },
    ],
  },
  {
    title: "Onion Hair Oil",
    type: "Haircare",
    variants: [
      { sku: "OHO-100", title: "100 ml", priceExGst: 449, cost: 128, stock: 980, weight: 18 },
      { sku: "OHO-200", title: "200 ml", priceExGst: 749, cost: 208, stock: 310, weight: 8 },
    ],
  },
  {
    title: "Ubtan Face Wash",
    type: "Skincare",
    variants: [
      { sku: "UFW-100", title: "100 g", priceExGst: 349, cost: 96, stock: 1240, weight: 16 },
    ],
  },
  {
    title: "Rosemary Scalp Tonic",
    type: "Haircare",
    variants: [
      // Stock levels are tuned against the 30-day velocity the trailing order
      // book produces, so at least two SKUs land under the 14-day stockout
      // threshold. Picked deliberately: an inventory demo where nothing is ever
      // at risk never renders the card the page exists for.
      { sku: "RST-60", title: "60 ml", priceExGst: 899, cost: 262, stock: 22, weight: 9 },
    ],
  },
  {
    title: "Niacinamide Serum",
    type: "Skincare",
    variants: [
      { sku: "NIA-30", title: "30 ml", priceExGst: 599, cost: 171, stock: 0, weight: 11 },
    ],
  },
  {
    title: "Cold Pressed Coconut Oil",
    type: "Wellness",
    variants: [
      { sku: "CPC-500", title: "500 ml", priceExGst: 549, cost: 189, stock: 2600, weight: 5 },
    ],
  },
  {
    title: "Sunscreen SPF 50",
    type: "Skincare",
    variants: [
      { sku: "SUN-50", title: "50 g", priceExGst: 649, cost: 198, stock: 130, weight: 12 },
      { sku: "SUN-100", title: "100 g", priceExGst: 1049, cost: 312, stock: 14, weight: 4 },
    ],
  },
  {
    title: "Biotin Gummies",
    type: "Wellness",
    variants: [
      { sku: "BIO-30", title: "30 count", priceExGst: 799, cost: 268, stock: 210, weight: 8 },
      { sku: "BIO-60", title: "60 count", priceExGst: 1399, cost: 452, stock: 96, weight: 5 },
    ],
  },
  {
    title: "Aloe Vera Gel",
    type: "Skincare",
    variants: [
      { sku: "ALV-200", title: "200 g", priceExGst: 299, cost: 82, stock: 1800, weight: 6 },
    ],
  },
  {
    title: "Anti-Dandruff Shampoo",
    type: "Haircare",
    variants: [
      { sku: "ADS-250", title: "250 ml", priceExGst: 499, cost: 151, stock: 340, weight: 9 },
    ],
  },
  {
    // The SKU --cost-gaps strips, chosen for low volume so the gap is a
    // realistic long-tail miss rather than a hole in the bestseller.
    title: "Gift Box — Festive Edition",
    type: "Bundles",
    variants: [
      { sku: "GBX-01", title: "Standard", priceExGst: 1899, cost: COST_GAPS ? null : 604, stock: 55, weight: 1 },
    ],
  },
  {
    title: "Beard Growth Kit",
    type: "Grooming",
    variants: [
      { sku: "BGK-01", title: "Kit", priceExGst: 1249, cost: 402, stock: 18, weight: 3 },
    ],
  },
];

const ALL_VARIANTS = CATALOGUE.flatMap((p) => p.variants);
const WEIGHT_TOTAL = ALL_VARIANTS.reduce((a, v) => a + v.weight, 0);

function pickVariant(): SeedVariant {
  let r = rnd() * WEIGHT_TOTAL;
  for (const v of ALL_VARIANTS) {
    r -= v.weight;
    if (r <= 0) return v;
  }
  return ALL_VARIANTS[0]!;
}

// ---------------------------------------------------------------------------
// Demand shape. A flat random order count per day makes every trend line
// straight, every day-of-week multiplier 1.0, and the entire forecast module
// untestable — so this carries real growth, a weekly rhythm and one festive
// spike, which is what an Indian D2C order book actually looks like.
// ---------------------------------------------------------------------------
const WEEKDAY_MULTIPLIER = [0.82, 1.12, 1.05, 1.0, 1.04, 1.18, 0.95]; // Sun..Sat

function ordersForDay(dayIndex: number, totalDays: number, date: Date): number {
  const growth = 0.55 + 1.1 * (dayIndex / totalDays); // ~2x over the year
  const weekday = WEEKDAY_MULTIPLIER[date.getUTCDay()]!;
  // Diwali sits in late October/early November for this window.
  const month = date.getUTCMonth();
  const festive = month === 9 || month === 10 ? 1.55 : 1;
  const noise = between(0.78, 1.24);
  return Math.max(1, Math.round(15 * growth * weekday * festive * noise));
}

// ---------------------------------------------------------------------------
// Target resolution + safety
// ---------------------------------------------------------------------------
interface Target {
  organizationId: string;
  legalEntityId: string;
  name: string;
  timezone: string;
}

async function listOrganizations() {
  const orgs = await prisma.organization.findMany({ select: { id: true, name: true, clerkOrgId: true } });
  const counts = await prisma.order.groupBy({ by: ["organizationId"], _count: { _all: true } });
  const byOrg = new Map(counts.map((c) => [c.organizationId, c._count._all]));
  const demoConns = await prisma.connection.findMany({
    where: { credentialsRef: { startsWith: DEMO_CREDENTIALS_PREFIX } },
    select: { organizationId: true },
  });
  const demoOrgs = new Set(demoConns.map((c) => c.organizationId));

  console.log("\norganisations:\n");
  for (const o of orgs) {
    const orders = byOrg.get(o.id) ?? 0;
    const tag = demoOrgs.has(o.id) ? "  [demo data present]" : orders > 0 ? "  [REAL DATA]" : "  [empty]";
    console.log(`  ${o.name.padEnd(30)} ${String(orders).padStart(7)} orders  ${o.clerkOrgId}${tag}`);
  }
  console.log("\nSeed one with:  npx tsx scripts/seedDemoData.ts --org \"<name or clerkOrgId>\"\n");
}

async function resolveTarget(query: string): Promise<Target> {
  const orgs = await prisma.organization.findMany({
    where: {
      OR: [{ clerkOrgId: query }, { id: query }, { name: { contains: query, mode: "insensitive" } }],
    },
    select: { id: true, name: true, timezone: true },
  });
  if (orgs.length === 0) throw new Error(`no organisation matches "${query}" — run with --list`);
  if (orgs.length > 1) {
    throw new Error(`"${query}" matches ${orgs.length} organisations: ${orgs.map((o) => o.name).join(", ")}`);
  }
  const org = orgs[0]!;

  let entity = await prisma.legalEntity.findFirst({ where: { organizationId: org.id } });
  if (!entity) {
    entity = await prisma.legalEntity.create({
      data: {
        organizationId: org.id,
        name: org.name.replace(DEMO_NAME_PREFIX, ""),
        category: "Beauty & Personal Care",
        primaryChannel: "D2C website",
        revenueRange: "₹1–5 Cr",
      },
    });
    console.log(`created legal entity "${entity.name}"`);
  }

  return { organizationId: org.id, legalEntityId: entity.id, name: org.name, timezone: org.timezone };
}

// Counts every row in the org that did NOT come from a demo connection. This is
// the check that stands between a demo and a repeat of the seed-fixture
// incident, so it counts each table rather than sampling one.
async function realDataIn(organizationId: string) {
  const demoConnIds = (
    await prisma.connection.findMany({
      where: { organizationId, credentialsRef: { startsWith: DEMO_CREDENTIALS_PREFIX } },
      select: { id: true },
    })
  ).map((c) => c.id);
  const notDemo = { notIn: demoConnIds };

  const [orders, payments, bank, ads, products, bills] = await Promise.all([
    prisma.order.count({ where: { organizationId, connectionId: notDemo } }),
    prisma.payment.count({ where: { organizationId, connectionId: notDemo } }),
    prisma.bankTransaction.count({ where: { organizationId, connectionId: notDemo } }),
    prisma.adSpend.count({ where: { organizationId, connectionId: notDemo } }),
    prisma.product.count({ where: { organizationId, connectionId: notDemo } }),
    prisma.vendorBill.count({ where: { organizationId, connectionId: notDemo } }),
  ]);
  return { orders, payments, bank, ads, products, bills, total: orders + payments + bank + ads + products + bills };
}

// ---------------------------------------------------------------------------
// Purge — exact, because every row descends from a marked connection
// ---------------------------------------------------------------------------
async function purge(target: Target) {
  const conns = await prisma.connection.findMany({
    where: { organizationId: target.organizationId, credentialsRef: { startsWith: DEMO_CREDENTIALS_PREFIX } },
    select: { id: true },
  });
  const ids = conns.map((c) => c.id);
  if (ids.length === 0) return console.log("no demo connections in this organisation — nothing to purge");

  const orders = await prisma.order.findMany({ where: { connectionId: { in: ids } }, select: { id: true } });
  const orderIds = orders.map((o) => o.id);

  console.log(`purging ${ids.length} demo connections and everything below them…`);
  await prisma.$transaction([
    // ReconciliationMatch has no orderId — it links generically through
    // sourceType/sourceId (an order on one side, a payment or settlement on the
    // other), so both sides have to be cleared by id.
    prisma.reconciliationMatch.deleteMany({
      where: { organizationId: target.organizationId, OR: [{ sourceId: { in: orderIds } }, { targetId: { in: orderIds } }] },
    }),
    prisma.reconciliationMatch.deleteMany({
      where: { organizationId: target.organizationId, sourceId: { startsWith: "demo_" } },
    }),
    prisma.reconciliationMatch.deleteMany({
      where: { organizationId: target.organizationId, targetId: { startsWith: "demo_" } },
    }),
    prisma.orderLineItem.deleteMany({ where: { orderId: { in: orderIds } } }),
    prisma.shipment.deleteMany({ where: { connectionId: { in: ids } } }),
    prisma.payment.deleteMany({ where: { connectionId: { in: ids } } }),
    prisma.settlement.deleteMany({ where: { connectionId: { in: ids } } }),
    prisma.order.deleteMany({ where: { connectionId: { in: ids } } }),
    prisma.bankTransaction.deleteMany({ where: { connectionId: { in: ids } } }),
    prisma.adSpend.deleteMany({ where: { connectionId: { in: ids } } }),
    prisma.productVariant.deleteMany({ where: { product: { connectionId: { in: ids } } } }),
    prisma.product.deleteMany({ where: { connectionId: { in: ids } } }),
    prisma.vendorBill.deleteMany({ where: { connectionId: { in: ids } } }),
    prisma.expense.deleteMany({ where: { connectionId: { in: ids } } }),
    prisma.productCost.deleteMany({ where: { organizationId: target.organizationId, note: "demo-seed" } }),
    prisma.connection.deleteMany({ where: { id: { in: ids } } }),
  ]);

  if (target.name.startsWith(DEMO_NAME_PREFIX)) {
    await prisma.organization.update({
      where: { id: target.organizationId },
      data: { name: target.name.slice(DEMO_NAME_PREFIX.length) },
    });
    console.log(`renamed organisation back to "${target.name.slice(DEMO_NAME_PREFIX.length)}"`);
  }
  console.log("purged.");
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------
async function makeConnection(target: Target, provider: Provider, externalAccountId: string, extra: Prisma.ConnectionUncheckedCreateInput["openingBalanceMinor"] extends never ? never : Partial<Prisma.ConnectionUncheckedCreateInput> = {}) {
  const connectionId = id(`conn_${provider.toLowerCase()}`);
  await prisma.connection.create({
    data: {
      id: connectionId,
      organizationId: target.organizationId,
      legalEntityId: target.legalEntityId,
      provider,
      status: "ACTIVE",
      externalAccountId,
      // The marker. On the parent, so nothing below it can be ambiguous.
      credentialsRef: `${DEMO_CREDENTIALS_PREFIX}${provider.toLowerCase()}`,
      lastSyncedAt: new Date(Date.now() - intBetween(3, 90) * 60_000),
      syncStatus: "IDLE",
      ...extra,
    },
  });
  return connectionId;
}

async function seed(target: Target) {
  const now = new Date();
  const totalDays = Math.round(MONTHS * 30.44);
  const start = new Date(now.getTime() - totalDays * DAY);
  console.log(`\nseeding ${MONTHS} months (${totalDays} days) into "${target.name}"\n`);

  // --- connections -------------------------------------------------------
  const shopifyConn = await makeConnection(target, "SHOPIFY", "demo-brand.myshopify.com");
  const razorpayConn = await makeConnection(target, "RAZORPAY", "acc_DemoBrand01");
  const shiprocketConn = await makeConnection(target, "SHIPROCKET", "demo-shiprocket");
  const metaConn = await makeConnection(target, "META_ADS", "act_708812345");
  const googleConn = await makeConnection(target, "GOOGLE_ADS", "412-887-9010");
  const zohoConn = await makeConnection(target, "ZOHO_BOOKS", "zb-demo-8891");
  // Bank visibility deliberately starts partway through the window: the trend
  // chart's "no cash figure rather than a zero" branch, and the coverage note
  // that goes with it, only exist because this is the normal real-world case.
  // 0.31 of the window, not 0.58: the default trend is the trailing SIX months,
  // and a gap that falls entirely outside it is a gap nobody ever sees. This
  // lands the start of bank visibility about four months back, so the chart the
  // Overview opens on genuinely shows the cash line beginning partway across.
  const bankVisibleFrom = new Date(now.getTime() - Math.round(totalDays * 0.31) * DAY);
  const bankConn = await makeConnection(target, "BANK", "HDFC-XXXX4471", {
    openingBalanceMinor: paise(1_84_000),
    openingBalanceDate: bankVisibleFrom,
  });
  console.log("connections: shopify, razorpay, shiprocket, meta ads, google ads, zoho books, bank");

  // --- products ----------------------------------------------------------
  const variantIdBySku = new Map<string, string>();
  for (const p of CATALOGUE) {
    const productId = id("prod");
    await prisma.product.create({
      data: {
        id: productId,
        organizationId: target.organizationId,
        legalEntityId: target.legalEntityId,
        connectionId: shopifyConn,
        externalProductId: `gid-${productId}`,
        title: p.title,
        productType: p.type,
        vendor: "Demo Brand",
        status: "active",
      },
    });
    await prisma.productVariant.createMany({
      data: p.variants.map((v) => {
        const variantId = id("var");
        variantIdBySku.set(v.sku, variantId);
        return {
          id: variantId,
          productId,
          externalVariantId: `gid-${variantId}`,
          sku: v.sku,
          title: v.title,
          // Shelf price is tax-inclusive, as it is in a real store.
          price: paise(Math.round(v.priceExGst * (1 + GST_RATE))),
          inventoryQuantity: v.stock,
        };
      }),
    });
  }
  console.log(`products: ${CATALOGUE.length} products, ${ALL_VARIANTS.length} variants`);

  // --- product costs -----------------------------------------------------
  await prisma.productCost.createMany({
    data: ALL_VARIANTS.filter((v) => v.cost !== null).map((v) => ({
      id: id("cost"),
      organizationId: target.organizationId,
      sku: v.sku,
      variantId: variantIdBySku.get(v.sku) ?? null,
      effectiveFrom: start,
      purchaseCost: paise(v.cost!),
      inboundFreight: paise(Math.round(v.cost! * 0.06)),
      importDuty: 0n,
      otherCost: paise(Math.round(v.cost! * 0.03)),
      landedCost: paise(Math.round(v.cost! * 1.09)),
      source: "MANUAL",
      note: "demo-seed",
    })),
    skipDuplicates: true,
  });
  const uncosted = ALL_VARIANTS.filter((v) => v.cost === null).length;
  console.log(`product costs: ${ALL_VARIANTS.length - uncosted} of ${ALL_VARIANTS.length} SKUs costed (${uncosted} deliberately left uncosted)`);

  // --- orders ------------------------------------------------------------
  const orderRows: Prisma.OrderCreateManyInput[] = [];
  const lineRows: Prisma.OrderLineItemCreateManyInput[] = [];
  const paymentRows: Prisma.PaymentCreateManyInput[] = [];
  const shipmentRows: Prisma.ShipmentCreateManyInput[] = [];

  const customers = Array.from({ length: 2600 }, (_, i) => `cust_${i}`);
  let orderNumber = 10_000;
  let codCollected = 0;

  for (let d = 0; d < totalDays; d += 1) {
    const day = new Date(start.getTime() + d * DAY);
    const count = ordersForDay(d, totalDays, day);

    for (let k = 0; k < count; k += 1) {
      const placedAt = new Date(day.getTime() + intBetween(0, 23) * 3_600_000 + intBetween(0, 59) * 60_000);
      const orderId = id("ord");
      orderNumber += 1;

      // 1–3 lines, weighted to one.
      const lineCount = chance(0.72) ? 1 : chance(0.75) ? 2 : 3;
      let itemsIncl = 0;
      const lines: { v: SeedVariant; qty: number; total: number }[] = [];
      for (let l = 0; l < lineCount; l += 1) {
        const v = pickVariant();
        const qty = chance(0.86) ? 1 : intBetween(2, 3);
        const total = Math.round(v.priceExGst * (1 + GST_RATE)) * qty;
        itemsIncl += total;
        lines.push({ v, qty, total });
      }

      // Discounts: most orders have none, a coupon cohort has 10–25%.
      const discountPct = chance(0.38) ? between(0.08, 0.25) : 0;
      const discountIncl = Math.round(itemsIncl * discountPct);
      // Free shipping above ₹999, as almost every Indian D2C store does.
      const shipping = itemsIncl - discountIncl >= 99_900 / 100 ? 0 : 49;

      const grossIncl = itemsIncl - discountIncl + shipping;
      const tax = Math.round((grossIncl * GST_RATE) / (1 + GST_RATE));

      const isCod = chance(0.58);
      const cancelled = chance(0.025);
      // Refunds sit on delivered prepaid orders far more often than COD.
      const refunded = !cancelled && chance(isCod ? 0.012 : 0.048);
      const refundAmount = refunded ? (chance(0.6) ? grossIncl : Math.round(grossIncl * between(0.3, 0.7))) : 0;
      // When the money actually went back. A refund never lands on the order
      // date — the customer has to receive the goods and return them first —
      // and the §15 leg 6 window is cut on this, so a refund stamped with the
      // order's own timestamp would fall outside the window the gateway's
      // refund line lands in and read as unmatched.
      const refundedAt = new Date(placedAt.getTime() + intBetween(3, 21) * 86_400_000);

      // ~1.5% raised in the admin on payment terms. These are the orders that
      // used to be classified as "No payment found" and are the reason the
      // `invoiced` status exists — a demo without them hides that whole path.
      const onTerms = !isCod && chance(0.015);

      // The connectors write exactly these three strings and no others —
      // shopify/index.ts, amazon/index.ts and flipkart/index.ts each hard-code
      // their own. "online_store" was invented here and would have put a
      // channel on the revenue-by-channel chart that no real sync can ever
      // produce.
      const channel = chance(0.8) ? "shopify" : chance(0.6) ? "amazon" : "flipkart";

      // ~1% of real orders carry no payment_gateway_names at all, which
      // classifyPaymentMode() maps to UNKNOWN. Without them, nothing exercises
      // the third branch of the prepaid/COD split (§68).
      const modeUnknown = !isCod && !onTerms && chance(0.012);
      const customerId = chance(0.35) ? pick(customers.slice(0, 900)) : pick(customers);

      // Order.status is Shopify's financial_status verbatim
      // (shopify/index.ts: `order.financial_status ?? order.fulfillment_status`).
      // "cancelled" is NOT one of its values — cancellation is the separate
      // cancelled_at field, and a cancelled order still reports voided or
      // refunded here. Emitting "cancelled" would have been a status string no
      // real sync can produce.
      const financialStatus = cancelled
        ? isCod
          ? "voided"
          : "refunded"
        : refunded
          ? refundAmount >= grossIncl
            ? "refunded"
            : "partially_refunded"
          : modeUnknown || onTerms
            ? "pending"
            : isCod
              ? chance(0.72)
                ? "paid"
                : "pending"
              : chance(0.004)
                ? "partially_paid"
                : "paid";

      orderRows.push({
        id: orderId,
        organizationId: target.organizationId,
        legalEntityId: target.legalEntityId,
        connectionId: shopifyConn,
        externalOrderId: `demo-${orderNumber}`,
        orderNumber: `#${orderNumber}`,
        channel,
        status: financialStatus,
        currency: "INR",
        grossAmount: paise(grossIncl),
        discountAmount: paise(discountIncl),
        taxAmount: paise(tax),
        itemsAmount: paise(itemsIncl),
        shippingAmount: paise(shipping),
        refundedAmount: paise(refundAmount),
        cancelledAt: cancelled ? new Date(placedAt.getTime() + intBetween(1, 40) * 3_600_000) : null,
        paymentMode: isCod ? "COD" : modeUnknown ? "UNKNOWN" : "PREPAID",
        customerRef: customerId,
        placedAt,
        // The shape Shopify actually sends, not a stub. Every key here is one
        // the application reads back out: reconciliation.ts's INVOICE_CONTEXT
        // pulls payment_terms, source_name, user_id, email,
        // confirmation_number, total_outstanding, tags and customer, and the
        // financial keys are what mapOrder() re-derives the columns from. A
        // demo whose raw is {source_name:"web"} makes every one of those read
        // null and the invoice-context panel render blank.
        raw: {
          id: Number(`9${orderNumber}`),
          name: `#${orderNumber}`,
          order_number: orderNumber,
          created_at: placedAt.toISOString(),
          currency: "INR",
          financial_status: financialStatus,
          fulfillment_status: cancelled ? null : "fulfilled",
          taxes_included: true,
          total_price: (grossIncl).toFixed(2),
          total_discounts: (discountIncl).toFixed(2),
          total_tax: (tax).toFixed(2),
          total_line_items_price: (itemsIncl).toFixed(2),
          total_shipping_price_set: { shop_money: { amount: shipping.toFixed(2), currency_code: "INR" } },
          // classifyPaymentMode() reads this array and nothing else — an empty
          // one is what produces UNKNOWN.
          payment_gateway_names: modeUnknown ? [] : isCod ? ["Cash on Delivery (COD)"] : ["razorpay"],
          customer: { id: Number(customerId.replace("cust_", "")) + 5_000_000, first_name: "Demo", last_name: "Customer" },
          tags: pick(["", "", "repeat", "first-order", "influencer", "bulk"]),
          // Only meaningful when something is still owed — an invoiced order.
          total_outstanding: onTerms ? grossIncl.toFixed(2) : "0.00",
          cancelled_at: cancelled ? new Date(placedAt.getTime() + intBetween(1, 40) * 3_600_000).toISOString() : null,
          // P2.3a-pre. refundedAmount used to be written onto the column with
          // NOTHING in refunds[] to back it — 154 demo orders claiming money
          // went back with no transaction saying when, how much, or through
          // which rail. mapRefunds() found nothing there and the §15 leg 6
          // reconciliation would have reported every one as permanently
          // unmatched, which is a demo artefact masquerading as a finding.
          //
          // A cancelled COD order is deliberately given a VOID rather than a
          // refund: an uncaptured authorisation moves no money, and the real
          // store has 1,981 orders of exactly that shape. The leg has to be
          // seen ignoring them, not just told that it does.
          refunds:
            refundAmount > 0
              ? [
                  {
                    id: Number(`77${orderNumber}`),
                    created_at: refundedAt.toISOString(),
                    processed_at: refundedAt.toISOString(),
                    transactions: [
                      {
                        id: Number(`88${orderNumber}`),
                        kind: "refund",
                        status: "success",
                        amount: refundAmount.toFixed(2),
                        gateway: isCod ? "Cash on Delivery (COD)" : "razorpay",
                        processed_at: refundedAt.toISOString(),
                        // Present most of the time, absent sometimes — the leg
                        // must degrade to amount+date matching, and a demo
                        // where every row has a clean reference never exercises
                        // that path.
                        receipt: chance(0.75) ? { refund_id: `rfnd_demo${orderNumber}` } : null,
                      },
                    ],
                    refund_line_items: [],
                  },
                ]
              : cancelled && isCod
                ? [
                    {
                      id: Number(`76${orderNumber}`),
                      created_at: placedAt.toISOString(),
                      processed_at: placedAt.toISOString(),
                      transactions: [{ id: Number(`86${orderNumber}`), kind: "void", status: "success", amount: "0.00" }],
                      refund_line_items: [],
                    },
                  ]
                : [],
          ...(onTerms
            ? {
                source_name: "shopify_draft_order",
                payment_terms: {
                  payment_terms_name: "Due on receipt",
                  payment_terms_type: "receipt",
                  due_in_days: 0,
                },
                user_id: 9182736450,
                email: "accounts@stockist.example",
                confirmation_number: `CN${orderNumber}`,
              }
            : { source_name: "web", payment_terms: null, user_id: null, email: `demo${orderNumber}@example.com`, confirmation_number: null }),
        },
      });

      for (const ln of lines) {
        const shareOfItems = ln.total / itemsIncl;
        lineRows.push({
          id: id("li"),
          orderId,
          sku: ln.v.sku,
          productName: ln.v.title === "Kit" || ln.v.title === "Standard" ? ln.v.sku : `${ln.v.sku} · ${ln.v.title}`,
          quantity: ln.qty,
          unitPrice: paise(Math.round(ln.v.priceExGst * (1 + GST_RATE))),
          totalAmount: paise(ln.total),
          cogsAmount: ln.v.cost === null ? null : paise(Math.round(ln.v.cost * 1.09 * ln.qty)),
          discountAmount: paise(Math.round(discountIncl * shareOfItems)),
          taxAmount: paise(Math.round(((ln.total - discountIncl * shareOfItems) * GST_RATE) / (1 + GST_RATE))),
          refundedAmount: paise(Math.round(refundAmount * shareOfItems)),
          refundedTaxAmount: paise(Math.round(((refundAmount * shareOfItems) * GST_RATE) / (1 + GST_RATE))),
          refundedQuantity: refundAmount > 0 ? ln.qty : 0,
        });
      }

      // --- payment (prepaid only) -----------------------------------------
      if (!isCod && !cancelled && !onTerms) {
        // 96% clean, 2% short by a small amount (lands in `review`), 2% never
        // captured at all (lands in `unmatched`). Both of those states exist in
        // the classifier and neither would ever appear in an all-happy seed.
        const roll = rnd();
        if (roll > 0.02) {
          const shortfall = roll > 0.04 ? 0 : Math.round(grossIncl * between(0.02, 0.12));
          const amount = grossIncl - shortfall;
          const method = pick(["upi", "upi", "upi", "card", "netbanking", "wallet"]);
          const capturedAt = new Date(placedAt.getTime() + intBetween(1, 300) * 1000);
          paymentRows.push({
            id: id("pay"),
            organizationId: target.organizationId,
            legalEntityId: target.legalEntityId,
            connectionId: razorpayConn,
            externalPaymentId: `pay_demo${orderNumber}`,
            orderId,
            amount: paise(amount),
            currency: "INR",
            method,
            status: "captured",
            // 2% + 18% GST on the fee, which is what Razorpay actually charges.
            feeAmount: paise(Math.round(amount * 0.02 * 1.18)),
            capturedAt: capturedAt,
            // Razorpay's payment entity. `raw` is never null on a real payment
            // (razorpay/index.ts writes the whole payload on both create and
            // update), and amounts there are in paise as integers, not strings.
            raw: {
              id: `pay_demo${orderNumber}`,
              entity: "payment",
              amount: Math.round(amount * 100),
              currency: "INR",
              status: "captured",
              order_id: `order_demo${orderNumber}`,
              method,
              captured: true,
              fee: Math.round(amount * 0.02 * 1.18 * 100),
              tax: Math.round(amount * 0.02 * 0.18 * 100),
              created_at: Math.floor(capturedAt.getTime() / 1000),
            },
          });
        }
      }

      // --- shipment --------------------------------------------------------
      if (!cancelled && !onTerms) {
        const pickedUpAt = new Date(placedAt.getTime() + intBetween(8, 40) * 3_600_000);
        const age = (now.getTime() - pickedUpAt.getTime()) / DAY;
        let status: ShipmentStatus;
        let deliveredAt: Date | null = null;

        if (age < 1) {
          status = "PICKED_UP";
        } else if (age < 4 && chance(0.55)) {
          status = chance(0.5) ? "IN_TRANSIT" : "OUT_FOR_DELIVERY";
        } else {
          // RTO is the number that decides whether an Indian D2C brand makes
          // money: 16% on COD against 3% prepaid.
          const rto = chance(isCod ? 0.16 : 0.03);
          if (rto) {
            status = chance(0.7) ? "RTO_DELIVERED" : "RTO_INITIATED";
          } else {
            status = "DELIVERED";
            deliveredAt = new Date(pickedUpAt.getTime() + intBetween(2, 6) * DAY);
            if (deliveredAt > now) deliveredAt = null;
            if (deliveredAt === null) status = "IN_TRANSIT";
          }
        }
        // Cancelled orders aside, a small share never leaves NEW (label
        // generated, pickup never happened) or is cancelled outright at the
        // courier. Both statuses exist in Shiprocket's own STATUS_MAP and in
        // the real data here; a seed without them means DISPATCHED_STATUSES —
        // the RTO-rate denominator — is never actually filtered by anything.
        if (chance(0.02)) status = "NEW";
        else if (chance(0.012)) status = "CANCELLED";
        if (status === "NEW" || status === "CANCELLED") deliveredAt = null;

        if (status === "DELIVERED" && isCod) codCollected += grossIncl;

        const awbCode = status === "NEW" ? null : `1490${orderNumber}${intBetween(10, 99)}`;
        const courierName = pick(["Delhivery Surface", "Bluedart", "Ecom Express", "XpressBees"]);
        const SHIPROCKET_LABEL: Record<string, string> = {
          NEW: "NEW",
          PICKED_UP: "PICKED UP",
          IN_TRANSIT: "IN TRANSIT",
          OUT_FOR_DELIVERY: "OUT FOR DELIVERY",
          DELIVERED: "DELIVERED",
          RTO_INITIATED: "RTO INITIATED",
          RTO_DELIVERED: "RTO DELIVERED",
          CANCELLED: "CANCELLED",
        };

        shipmentRows.push({
          id: id("shp"),
          organizationId: target.organizationId,
          legalEntityId: target.legalEntityId,
          connectionId: shiprocketConn,
          externalShipmentId: `srp-${orderNumber}`,
          orderId,
          awbCode,
          courierName,
          status,
          codAmount: isCod ? paise(grossIncl) : null,
          // A NEW shipment has a label but no pickup — pickedUpAt is what the
          // RTO calc buckets on, and it falls back to createdAt when absent.
          pickedUpAt: status === "NEW" ? null : pickedUpAt,
          deliveredAt,
          // Shiprocket's own payload. Never null on a real row, and it carries
          // the RAW status string that mapStatus() translated — which is the
          // only way to check a mapping after the fact.
          raw: {
            id: Number(`77${orderNumber}`),
            awb: awbCode,
            courier_name: courierName,
            status: SHIPROCKET_LABEL[status] ?? "UNKNOWN",
            current_status: SHIPROCKET_LABEL[status] ?? "UNKNOWN",
            pickup_date: status === "NEW" ? null : pickedUpAt.toISOString(),
            delivered_date: deliveredAt ? deliveredAt.toISOString() : null,
            cod_amount: isCod ? grossIncl : 0,
            freight_charges: null,
            order_id: `#${orderNumber}`,
          },
        });
      }
    }
  }

  await batchCreate("orders", orderRows, (rows) => prisma.order.createMany({ data: rows, skipDuplicates: true }));
  await batchCreate("line items", lineRows, (rows) => prisma.orderLineItem.createMany({ data: rows, skipDuplicates: true }));
  await batchCreate("payments", paymentRows, (rows) => prisma.payment.createMany({ data: rows, skipDuplicates: true }));
  await batchCreate("shipments", shipmentRows, (rows) => prisma.shipment.createMany({ data: rows, skipDuplicates: true }));

  // --- settlements: prepaid payouts on a T+2 cycle ------------------------
  const settlementRows: Prisma.SettlementCreateManyInput[] = [];
  const byDay = new Map<string, { gross: number; fee: number }>();
  for (const p of paymentRows) {
    const key = new Date(p.capturedAt as Date).toISOString().slice(0, 10);
    const acc = byDay.get(key) ?? { gross: 0, fee: 0 };
    acc.gross += Number(p.amount) / 100;
    acc.fee += Number(p.feeAmount) / 100;
    byDay.set(key, acc);
  }
  for (const [dayKey, acc] of byDay) {
    const settledAt = new Date(new Date(`${dayKey}T00:00:00Z`).getTime() + 2 * DAY + 11 * 3_600_000);
    // The most recent two days have not settled yet — which is exactly what
    // "pending settlements" is supposed to measure.
    if (settledAt > now) continue;
    settlementRows.push({
      id: id("stl"),
      organizationId: target.organizationId,
      legalEntityId: target.legalEntityId,
      connectionId: razorpayConn,
      externalSettlementId: `setl_${dayKey.replaceAll("-", "")}`,
      amount: paise(Math.round(acc.gross - acc.fee)),
      feeAmount: paise(Math.round(acc.fee)),
      utr: `UTR${dayKey.replaceAll("-", "")}${intBetween(1000, 9999)}`,
      status: "processed",
      settledAt,
      raw: {
        id: `setl_${dayKey.replaceAll("-", "")}`,
        entity: "settlement",
        amount: Math.round((acc.gross - acc.fee) * 100),
        status: "processed",
        fees: Math.round(acc.fee * 100),
        tax: Math.round(acc.fee * 0.18 * 100),
        utr: `UTR${dayKey.replaceAll("-", "")}`,
        created_at: Math.floor(settledAt.getTime() / 1000),
      },
    });
  }
  await batchCreate("settlements", settlementRows, (rows) => prisma.settlement.createMany({ data: rows, skipDuplicates: true }));

  // --- ad spend -----------------------------------------------------------
  const adRows: Prisma.AdSpendCreateManyInput[] = [];
  for (let d = 0; d < totalDays; d += 1) {
    const date = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + d));
    const scale = 0.6 + 1.0 * (d / totalDays);
    const festive = date.getUTCMonth() === 9 || date.getUTCMonth() === 10 ? 1.7 : 1;

    const metaSpend = Math.round(9_500 * scale * festive * between(0.8, 1.25));
    adRows.push({
      id: id("ad"),
      organizationId: target.organizationId,
      legalEntityId: target.legalEntityId,
      connectionId: metaConn,
      provider: "META_ADS",
      externalAccountId: "act_708812345",
      date,
      spendAmount: paise(metaSpend),
      impressions: Math.round(metaSpend * between(28, 45)),
      clicks: Math.round(metaSpend * between(0.35, 0.7)),
      currency: "INR",
      raw: { date_start: date.toISOString().slice(0, 10), date_stop: date.toISOString().slice(0, 10), spend: metaSpend.toFixed(2), account_currency: "INR" },
    });

    const googleSpend = Math.round(4_200 * scale * festive * between(0.75, 1.3));
    adRows.push({
      id: id("ad"),
      organizationId: target.organizationId,
      legalEntityId: target.legalEntityId,
      connectionId: googleConn,
      provider: "GOOGLE_ADS",
      externalAccountId: "412-887-9010",
      date,
      spendAmount: paise(googleSpend),
      impressions: Math.round(googleSpend * between(12, 22)),
      clicks: Math.round(googleSpend * between(0.28, 0.55)),
      currency: "INR",
      raw: { segments: { date: date.toISOString().slice(0, 10) }, metrics: { costMicros: String(googleSpend * 1_000_000) } },
    });

    // Off by default: a USD account makes every ad total legitimately refuse to
    // sum, which is correct behaviour and a confusing first impression. Pass
    // --mixed-currency to exercise that guard on purpose.
    if (MIXED_CURRENCY) {
      adRows.push({
        id: id("ad"),
        organizationId: target.organizationId,
        legalEntityId: target.legalEntityId,
        connectionId: metaConn,
        provider: "META_ADS",
        externalAccountId: "act_990011223",
        date,
        spendAmount: BigInt(Math.round(between(15, 60) * 100)),
        impressions: intBetween(2000, 9000),
        clicks: intBetween(40, 260),
        currency: "USD",
      });
    }
  }
  await batchCreate("ad spend", adRows, (rows) => prisma.adSpend.createMany({ data: rows, skipDuplicates: true }));

  // --- bank ---------------------------------------------------------------
  const bankRows: Prisma.BankTransactionCreateManyInput[] = [];
  const credit = (valueDate: Date, amount: number, description: string, utr?: string) =>
    bankRows.push({
      id: id("btx"),
      organizationId: target.organizationId,
      legalEntityId: target.legalEntityId,
      connectionId: bankConn,
      externalTxnId: id("btxid"),
      amount: paise(amount),
      direction: "CREDIT",
      valueDate,
      description,
      utr: utr ?? null,
    });
  const debit = (valueDate: Date, amount: number, description: string) =>
    bankRows.push({
      id: id("btx"),
      organizationId: target.organizationId,
      legalEntityId: target.legalEntityId,
      connectionId: bankConn,
      externalTxnId: id("btxid"),
      amount: paise(amount),
      direction: "DEBIT",
      valueDate,
      description,
    });

  // Gateway payouts land as bank credits one day after settlement.
  for (const s of settlementRows) {
    const at = new Date((s.settledAt as Date).getTime() + DAY);
    if (at < bankVisibleFrom || at > now) continue;
    credit(at, Number(s.amount) / 100, "RAZORPAY PAYOUT", s.utr ?? undefined);
  }
  // COD remittance arrives weekly, on a courier's own cycle.
  for (let d = 0; d < totalDays; d += 7) {
    const at = new Date(start.getTime() + d * DAY);
    if (at < bankVisibleFrom || at > now) continue;
    credit(at, Math.round((codCollected / totalDays) * 7 * between(0.85, 1.1)), "SHIPROCKET COD REMITTANCE");
  }
  // Outflows.
  for (let d = 0; d < totalDays; d += 1) {
    const at = new Date(start.getTime() + d * DAY);
    if (at < bankVisibleFrom || at > now) continue;
    if (at.getUTCDate() === 1) {
      debit(at, 265_000, "SALARY PAYOUT");
      debit(at, 95_000, "OFFICE RENT");
      debit(at, 18_400, "SOFTWARE SUBSCRIPTIONS");
    }
    if (at.getUTCDay() === 1) debit(at, Math.round(between(60_000, 130_000)), "META PLATFORMS ADS");
    if (at.getUTCDay() === 3) debit(at, Math.round(between(22_000, 52_000)), "GOOGLE ADS");
    if (chance(0.22)) debit(at, Math.round(between(18_000, 240_000)), pick(["PACKAGING SUPPLIER", "CONTRACT MANUFACTURER", "COURIER FREIGHT", "GST PAYMENT"]));
  }
  await batchCreate("bank transactions", bankRows, (rows) => prisma.bankTransaction.createMany({ data: rows, skipDuplicates: true }));

  // --- vendor bills + expenses -------------------------------------------
  const vendors = ["Aurora Packaging Pvt Ltd", "Sattva Contract Mfg", "Indigo Labels", "RapidShip Logistics", "Vertex Ingredients"];
  const billRows: Prisma.VendorBillCreateManyInput[] = [];
  for (let i = 0; i < 42; i += 1) {
    const billDate = new Date(now.getTime() - intBetween(0, 150) * DAY);
    const dueDate = new Date(billDate.getTime() + pick([15, 30, 30, 45]) * DAY);
    const total = Math.round(between(35_000, 480_000));
    // Roughly a third are settled, and some of what remains is genuinely late —
    // an ageing report where nothing is ever overdue is not an ageing report.
    const paid = chance(0.34);
    const overdue = !paid && dueDate < now;
    billRows.push({
      id: id("bill"),
      organizationId: target.organizationId,
      legalEntityId: target.legalEntityId,
      connectionId: zohoConn,
      externalBillId: `zb-${i}-${id("b")}`,
      billNumber: `BILL-2026-${(1000 + i).toString()}`,
      vendorName: pick(vendors),
      billDate,
      dueDate,
      totalAmount: paise(total),
      balanceAmount: paid ? 0n : paise(chance(0.2) ? Math.round(total * between(0.3, 0.8)) : total),
      currency: "INR",
      status: paid ? "paid" : overdue ? "overdue" : "open",
    });
  }
  await batchCreate("vendor bills", billRows, (rows) => prisma.vendorBill.createMany({ data: rows, skipDuplicates: true }));

  const expenseRows: Prisma.ExpenseCreateManyInput[] = [];
  const heads = ["Rent", "Payroll", "Advertising", "Packaging", "Software", "Freight", "Professional fees"];
  for (let d = 0; d < totalDays; d += 3) {
    const at = new Date(start.getTime() + d * DAY);
    const head = pick(heads);
    expenseRows.push({
      id: id("exp"),
      organizationId: target.organizationId,
      legalEntityId: target.legalEntityId,
      connectionId: zohoConn,
      externalExpenseId: id("expid"),
      expenseDate: at,
      accountName: head,
      vendorName: pick(vendors),
      description: `${head} — ${at.toISOString().slice(0, 10)}`,
      amount: paise(Math.round(between(8_000, 180_000))),
      taxAmount: 0n,
      currency: "INR",
      status: "recorded",
    });
  }
  await batchCreate("expenses", expenseRows, (rows) => prisma.expense.createMany({ data: rows, skipDuplicates: true }));

  // --- mark the organisation ---------------------------------------------
  if (!target.name.startsWith(DEMO_NAME_PREFIX)) {
    await prisma.organization.update({
      where: { id: target.organizationId },
      data: { name: `${DEMO_NAME_PREFIX}${target.name}` },
    });
    console.log(`\nrenamed organisation to "${DEMO_NAME_PREFIX}${target.name}" — the frontend shows a banner on this prefix`);
  }

  console.log(`\nbank visibility begins ${bankVisibleFrom.toISOString().slice(0, 10)} — earlier months carry NO cash figure, not a zero`);
  console.log("run the reconciliation engine next:  npx tsx scripts/checkReconciliation.ts");
}

async function batchCreate<T>(label: string, rows: T[], write: (batch: T[]) => Promise<unknown>) {
  const BATCH = 2000;
  for (let i = 0; i < rows.length; i += BATCH) await write(rows.slice(i, i + BATCH));
  console.log(`${label}: ${rows.length.toLocaleString("en-IN")}`);
}

// ---------------------------------------------------------------------------
async function main() {
  if (LIST || !ORG_QUERY) {
    await listOrganizations();
    if (!ORG_QUERY) console.log("--org is required.\n");
    return;
  }

  const target = await resolveTarget(ORG_QUERY);
  console.log(`target: "${target.name}" (${target.organizationId})`);

  if (PURGE) return purge(target);

  const real = await realDataIn(target.organizationId);
  if (real.total > 0 && !FORCE) {
    console.log(`\nREFUSING — this organisation already holds data that did not come from this seeder:`);
    console.log(`  orders ${real.orders}  payments ${real.payments}  bank ${real.bank}  ad spend ${real.ads}  products ${real.products}  bills ${real.bills}`);
    console.log(
      `\nSynthetic rows next to real ones are indistinguishable once written, and they count toward\n` +
        `every metric. This has happened here before — see scripts/purgeSeedFixtures.ts.\n\n` +
        `Use an empty organisation (--list shows which are empty), or --force if you genuinely\n` +
        `mean to mix them.\n`
    );
    process.exitCode = 1;
    return;
  }
  if (real.total > 0) console.log(`\n--force: writing demo data alongside ${real.total} real rows. This is not reversible by --purge.\n`);

  // A re-run replaces rather than stacks: without this, seeding twice doubles
  // every metric and the second run looks like a very good month.
  await purge(target);
  await seed(await resolveTarget(ORG_QUERY));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
