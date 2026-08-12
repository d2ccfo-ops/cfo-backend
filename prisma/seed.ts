import { PrismaClient } from "@prisma/client";
import type { ShipmentStatus } from "@prisma/client";

const prisma = new PrismaClient();

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Roughly matches the ~11% RTO rate already used as the mock value on the
// Overview page, so seeding doesn't produce a number wildly different from
// what the UI shows before real data is wired up.
const SHIPMENT_STATUS_WEIGHTS: [ShipmentStatus, number][] = [
  ["DELIVERED", 62],
  ["IN_TRANSIT", 14],
  ["OUT_FOR_DELIVERY", 8],
  ["PICKED_UP", 4],
  ["RTO_INITIATED", 4],
  ["RTO_DELIVERED", 7],
  ["NEW", 1],
];
const COURIERS = ["Delhivery", "Xpressbees", "Ecom Express", "Bluedart"];

function randomShipmentStatus(): ShipmentStatus {
  const total = SHIPMENT_STATUS_WEIGHTS.reduce((sum, [, w]) => sum + w, 0);
  let roll = Math.random() * total;
  for (const [status, weight] of SHIPMENT_STATUS_WEIGHTS) {
    if (roll < weight) return status;
    roll -= weight;
  }
  return "DELIVERED";
}

async function main() {
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: "asc" } });
  if (!org) {
    console.error("No organization found. Sign up and complete onboarding in the app first, then re-run this seed.");
    process.exit(1);
  }

  let legalEntity = await prisma.legalEntity.findFirst({ where: { organizationId: org.id } });
  if (!legalEntity) {
    legalEntity = await prisma.legalEntity.create({ data: { organizationId: org.id, name: org.name } });
  }

  // Orders/Shipments only need *a* connectionId string to attach to — there's
  // no foreign key enforcing it points at a real Connection row (check any
  // migration.sql: connectionId is a plain column, never a FK, on Order/
  // Shipment/BankTransaction). So these are synthetic IDs, not real
  // Connection rows, on purpose — a real bug earlier in this project's life
  // seeded actual Connection rows for Shopify/Shiprocket, which then made
  // `GET /connections` report them as "already connected" and hid the real
  // ShopifyConnectCard/ShiprocketConnectCard forms on the Connections page
  // behind fake data. Never create a real Connection row here for a provider
  // whose frontend card treats "a connection exists" as "hide the connect
  // form" (Shopify, Razorpay, Shiprocket) — only BANK is safe to seed a real
  // Connection for, because BankAccountsSection always shows the add-account
  // form regardless of what's already connected, and the opening-balance
  // anchor genuinely has to live on a real Connection row (see
  // modules/calc/cash.ts).
  const SEED_SHOPIFY_CONNECTION_ID = "seed-fixture-shopify";
  const SEED_SHIPROCKET_CONNECTION_ID = "seed-fixture-shiprocket";

  const seedNow = new Date();
  const bankOpeningBalance = {
    openingBalanceMinor: BigInt(15_00_000_00), // ₹15,00,000 as of the start of last month
    openingBalanceDate: new Date(Date.UTC(seedNow.getUTCFullYear(), seedNow.getUTCMonth() - 1, 1)),
  };
  let bankConnection = await prisma.connection.findFirst({ where: { organizationId: org.id, provider: "BANK" } });
  if (!bankConnection) {
    bankConnection = await prisma.connection.create({
      data: {
        organizationId: org.id,
        legalEntityId: legalEntity.id,
        provider: "BANK",
        status: "ACTIVE",
        externalAccountId: "Seed Bank •••0000",
        credentialsRef: "seed-fixture",
        lastSyncedAt: new Date(),
        ...bankOpeningBalance,
      },
    });
  } else if (bankConnection.openingBalanceMinor == null) {
    bankConnection = await prisma.connection.update({ where: { id: bankConnection.id }, data: bankOpeningBalance });
  }

  // Idempotent: wipe previously seeded orders/shipments/bank txns before regenerating.
  await prisma.shipment.deleteMany({ where: { connectionId: SEED_SHIPROCKET_CONNECTION_ID, externalShipmentId: { startsWith: "seed-" } } });
  await prisma.order.deleteMany({ where: { connectionId: SEED_SHOPIFY_CONNECTION_ID, externalOrderId: { startsWith: "seed-" } } });
  await prisma.bankTransaction.deleteMany({ where: { connectionId: bankConnection.id, externalTxnId: { startsWith: "seed-" } } });

  const now = new Date();
  const dayOfMonth = now.getUTCDate();
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const priorMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

  const orders: {
    organizationId: string;
    legalEntityId: string;
    connectionId: string;
    externalOrderId: string;
    orderNumber: string;
    channel: string;
    status: string;
    grossAmount: bigint;
    discountAmount: bigint;
    taxAmount: bigint;
    placedAt: Date;
  }[] = [];

  for (const [monthOffset, monthStart] of [
    [0, priorMonthStart],
    [1, currentMonthStart],
  ] as const) {
    for (let day = 0; day < dayOfMonth; day++) {
      const ordersToday = randomInt(3, 7);
      for (let i = 0; i < ordersToday; i++) {
        const gross = BigInt(randomInt(60000, 450000)); // paise: ~₹600-4500 per order
        const discount = (gross * BigInt(randomInt(3, 10))) / 100n;
        const taxableBase = gross - discount;
        const tax = (taxableBase * 18n) / 118n; // approx GST component, gross treated as tax-inclusive

        const placedAt = new Date(monthStart);
        placedAt.setUTCDate(placedAt.getUTCDate() + day);
        placedAt.setUTCHours(randomInt(8, 22), randomInt(0, 59), 0, 0);

        orders.push({
          organizationId: org.id,
          legalEntityId: legalEntity.id,
          connectionId: SEED_SHOPIFY_CONNECTION_ID,
          externalOrderId: `seed-${monthOffset}-${day}-${i}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          orderNumber: `#${1000 + orders.length}`,
          channel: "shopify",
          status: "paid",
          grossAmount: gross,
          discountAmount: discount,
          taxAmount: tax,
          placedAt,
        });
      }
    }
  }

  let shipmentCount = 0;
  for (const order of orders) {
    const created = await prisma.order.create({ data: order });

    // Not every order has shipped yet — skip a few so "dispatched" isn't 1:1
    // with "ordered", same as a real store.
    if (Math.random() < 0.05) continue;

    const status = randomShipmentStatus();
    await prisma.shipment.create({
      data: {
        organizationId: org.id,
        legalEntityId: legalEntity.id,
        connectionId: SEED_SHIPROCKET_CONNECTION_ID,
        externalShipmentId: `seed-ship-${created.id}`,
        orderId: created.id,
        awbCode: `SEEDAWB${randomInt(100000, 999999)}`,
        courierName: COURIERS[randomInt(0, COURIERS.length - 1)],
        status,
        deliveredAt: status === "DELIVERED" ? created.placedAt : null,
        createdAt: created.placedAt,
      },
    });
    shipmentCount++;
  }

  const CREDIT_DESCRIPTIONS = ["Razorpay settlement", "Amazon payout", "UPI collection"];
  const DEBIT_DESCRIPTIONS = ["Meta Ads billing", "Packaging vendor payment", "Delhivery COD remittance fee"];

  let bankTxnCount = 0;
  for (const [monthOffset, monthStart] of [
    [0, priorMonthStart],
    [1, currentMonthStart],
  ] as const) {
    for (let day = 0; day < dayOfMonth; day++) {
      const valueDate = new Date(monthStart);
      valueDate.setUTCDate(valueDate.getUTCDate() + day);
      valueDate.setUTCHours(randomInt(9, 18), randomInt(0, 59), 0, 0);

      const creditsToday = randomInt(1, 2);
      for (let i = 0; i < creditsToday; i++) {
        await prisma.bankTransaction.create({
          data: {
            organizationId: org.id,
            legalEntityId: legalEntity.id,
            connectionId: bankConnection.id,
            externalTxnId: `seed-credit-${monthOffset}-${day}-${i}`,
            amount: BigInt(randomInt(4_00000, 18_00000)), // paise: ~₹40k-180k per settlement
            direction: "CREDIT",
            valueDate,
            description: CREDIT_DESCRIPTIONS[randomInt(0, CREDIT_DESCRIPTIONS.length - 1)],
          },
        });
        bankTxnCount++;
      }

      // Not every day has an outgoing payment — real cash-out is lumpier than cash-in.
      if (Math.random() < 0.4) {
        await prisma.bankTransaction.create({
          data: {
            organizationId: org.id,
            legalEntityId: legalEntity.id,
            connectionId: bankConnection.id,
            externalTxnId: `seed-debit-${monthOffset}-${day}`,
            amount: BigInt(randomInt(50000, 3_00000)), // paise: ~₹500-3000
            direction: "DEBIT",
            valueDate,
            description: DEBIT_DESCRIPTIONS[randomInt(0, DEBIT_DESCRIPTIONS.length - 1)],
          },
        });
        bankTxnCount++;
      }
    }
  }

  console.log(
    `Seeded ${orders.length} fake orders, ${shipmentCount} fake shipments, and ${bankTxnCount} fake bank transactions for "${org.name}" (${org.id}) across this month and last month.`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
