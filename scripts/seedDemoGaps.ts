/**
 * Fills the DEMO organisation's remaining data gaps — the ones that block
 * P6.3–P6.8 — so development does not have to wait on D1–D7 arriving from the
 * real world.
 *
 *   npx tsx scripts/seedDemoGaps.ts --org "DEMO — technox pvt ltd"
 *   npx tsx scripts/seedDemoGaps.ts --org "DEMO — technox pvt ltd" --purge
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE SCRIPT FROM seedDemoData.ts
 * ---------------------------------------------------------------------------
 * seedDemoData.ts builds an organisation from nothing. This one runs ON TOP of
 * an org it already built, adding the fact tables that were never generated:
 * courier freight invoices, gateway settlement composition, and marketplace
 * fees. Merging them would mean re-generating 6,663 orders to add a freight
 * invoice, and every id in the demo would change on every run.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THIS SCRIPT EXISTS TO NOT BREAK
 * ---------------------------------------------------------------------------
 * Fabricated data is not dangerous because it is wrong. It is dangerous because
 * once written it is INDISTINGUISHABLE from measured data. The real org
 * ("Hrtiik pvt ltd") is where someone goes to find out what their business
 * actually did; a plausible-looking cost written there would be believed.
 *
 * So, exactly as seedDemoData.ts does:
 *
 *  1. It REFUSES any organisation whose name does not carry the "DEMO — "
 *     prefix. Not a warning. There is no --force, because unlike the base
 *     seeder there is no legitimate reason to want this in a real org.
 *  2. Every row hangs off a Connection whose credentialsRef starts with
 *     "demo-seed:", so --purge is exact rather than heuristic.
 *  3. It is deterministic — same org, same seed, same invoices.
 *
 * ---------------------------------------------------------------------------
 * WHY IT DRIVES THE REAL INGEST PATHS INSTEAD OF INSERTING ROWS
 * ---------------------------------------------------------------------------
 * Freight invoices go through applyInvoice(), and settlement composition goes
 * through ingestStatement() with the connector's own StatementFormat — the same
 * functions the upload routes call. Inserting the rows directly would be easier
 * and would prove nothing: the shapes would be whatever I imagined, and the
 * first real Bluedart PDF would disagree. Driving the real parsers means the
 * demo exercises the code that will meet the real file, and a format mistake
 * shows up here rather than on the day the data lands.
 *
 * The generated CSVs use the column spellings the connectors actually declare
 * (BLUEDART_COD_STATEMENT, GOKWIK_SETTLEMENT_STATEMENT), which were themselves
 * taken from real reports.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import { applyInvoice, type InvoiceLine, type ParsedInvoice } from "../src/modules/connectors/bluedart/invoice.js";
import { GOKWIK_SETTLEMENT_STATEMENT } from "../src/modules/connectors/gokwik/index.js";
import { ingestStatement } from "../src/modules/connectors/remittance/statement.js";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const PURGE = flag("purge");
const ORG_QUERY = value("org");

const DEMO_CREDENTIALS_PREFIX = "demo-seed:";
const DEMO_NAME_PREFIX = "DEMO — ";

// ---------------------------------------------------------------------------
// Deterministic randomness — a different seed from seedDemoData.ts so the two
// do not draw the same sequence and produce suspiciously correlated numbers.
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
const rnd = mulberry32(20260813);
const between = (lo: number, hi: number) => lo + rnd() * (hi - lo);
const intBetween = (lo: number, hi: number) => Math.floor(between(lo, hi + 1));
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
const paise = (rupees: number) => BigInt(Math.round(rupees * 100));

const INDIAN_CITIES = [
  "MUMBAI", "DELHI", "BANGALORE", "HYDERABAD", "CHENNAI", "PUNE", "KOLKATA",
  "AHMEDABAD", "JAIPUR", "LUCKNOW", "SURAT", "INDORE", "NAGPUR", "PATNA",
] as const;

interface Target {
  organizationId: string;
  organizationName: string;
  legalEntityId: string;
}

// ---------------------------------------------------------------------------
// Target resolution — the refusal that keeps this out of real orgs
// ---------------------------------------------------------------------------
async function resolveTarget(query: string): Promise<Target> {
  const orgs = await prisma.organization.findMany({
    where: { OR: [{ id: query }, { name: { contains: query, mode: "insensitive" } }] },
    select: { id: true, name: true, legalEntities: { select: { id: true, name: true } } },
  });
  if (orgs.length === 0) throw new Error(`No organisation matches "${query}".`);
  if (orgs.length > 1) {
    throw new Error(
      `"${query}" matches ${orgs.length} organisations:\n${orgs.map((o) => `  ${o.name} (${o.id})`).join("\n")}\nPass the id.`
    );
  }
  const org = orgs[0]!;

  // The refusal. A name prefix is a weak guard on its own, which is why the
  // base seeder applies it as part of seeding — an org carrying this prefix has
  // already been declared synthetic, and the frontend shows a banner for it.
  if (!org.name.startsWith(DEMO_NAME_PREFIX)) {
    throw new Error(
      `REFUSED: "${org.name}" is not a demo organisation.\n\n` +
        `This script writes fabricated freight invoices, settlement lines and marketplace\n` +
        `fees. In an organisation holding real data those numbers become indistinguishable\n` +
        `from measured ones — the Profitability page would show a margin that is fiction and\n` +
        `look exactly like a real margin.\n\n` +
        `Run scripts/seedDemoData.ts --org "${org.name}" first if this is meant to be a demo\n` +
        `org; it applies the "${DEMO_NAME_PREFIX}" prefix that this script requires.`
    );
  }

  const entity = org.legalEntities[0];
  if (!entity) throw new Error(`"${org.name}" has no legal entity — run seedDemoData.ts first.`);
  return { organizationId: org.id, organizationName: org.name, legalEntityId: entity.id };
}

async function demoConnection(target: Target, provider: Prisma.ConnectionUncheckedCreateInput["provider"], externalAccountId: string) {
  const existing = await prisma.connection.findFirst({
    where: { organizationId: target.organizationId, provider, credentialsRef: { startsWith: DEMO_CREDENTIALS_PREFIX } },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await prisma.connection.create({
    data: {
      organizationId: target.organizationId,
      legalEntityId: target.legalEntityId,
      provider,
      externalAccountId,
      credentialsRef: `${DEMO_CREDENTIALS_PREFIX}${provider.toLowerCase()}`,
      status: "ACTIVE",
      lastSyncedAt: new Date(),
    },
    select: { id: true },
  });
  return created.id;
}

// ---------------------------------------------------------------------------
// PURGE
// ---------------------------------------------------------------------------
async function purge(target: Target) {
  const conns = await prisma.connection.findMany({
    where: { organizationId: target.organizationId, credentialsRef: { startsWith: DEMO_CREDENTIALS_PREFIX } },
    select: { id: true, provider: true },
  });
  const ids = conns.map((c) => c.id);

  const invoices = await prisma.freightInvoice.deleteMany({ where: { organizationId: target.organizationId, connectionId: { in: ids } } });
  // Freight written onto shipments by applyInvoice() is not owned by a
  // connection, so it is cleared explicitly — leaving it would keep the
  // forward-shipping layer "covered" by an invoice that no longer exists.
  const shipments = await prisma.shipment.updateMany({
    where: { organizationId: target.organizationId },
    data: { freightAmount: null },
  });
  const settlements = await prisma.settlement.deleteMany({
    where: { organizationId: target.organizationId, connectionId: { in: ids }, externalSettlementId: { startsWith: "DEMOGAP" } },
  });
  // Marketplace payments are keyed to the AMAZON/FLIPKART demo connections, so
  // deleting by connection removes exactly what this script created and leaves
  // the base seeder's payments alone.
  const marketplaceConnIds = conns.filter((c) => c.provider === "AMAZON" || c.provider === "FLIPKART").map((c) => c.id);
  const payments = await prisma.payment.deleteMany({
    where: { organizationId: target.organizationId, connectionId: { in: marketplaceConnIds } },
  });

  console.log(
    `purged: ${invoices.count} freight invoices, ${settlements.count} settlements, ` +
      `${payments.count} marketplace payments, freight cleared on ${shipments.count} shipments`
  );
}

// ---------------------------------------------------------------------------
// 1. COURIER FREIGHT INVOICES (data register D5)
// ---------------------------------------------------------------------------
// Bluedart bills monthly, one invoice per product ("Etail Air COD" /
// "Etail Air Prepaid"), one line per waybill. What makes this worth generating
// rather than stubbing is the three row kinds a real invoice carries and the
// downstream code that has never seen any of them:
//
//   · an ordinary outbound leg
//   · a RETURN leg on the same AWB, prefixed (R) — an RTO costs freight TWICE,
//     and this is the only place reverse shipping is ever stated
//   · a CREDIT, a negative row where the courier refunded an overcharge
//
// It also deliberately bills for a few AWBs this system has no shipment for.
// That is not noise — it is the real and common case of a courier charging for
// a parcel that was never booked through us, and the only place it surfaces.
async function seedFreightInvoices(target: Target, connectionId: string) {
  const shipments = await prisma.shipment.findMany({
    where: { organizationId: target.organizationId, awbCode: { not: null } },
    select: { awbCode: true, status: true, createdAt: true, pickedUpAt: true },
    orderBy: { createdAt: "asc" },
  });
  if (shipments.length === 0) {
    console.log("  no shipments with an AWB — skipping freight invoices");
    return;
  }

  // Group by calendar month, which is how the courier invoices.
  const byMonth = new Map<string, typeof shipments>();
  for (const s of shipments) {
    const at = s.pickedUpAt ?? s.createdAt;
    const key = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
    const bucket = byMonth.get(key) ?? [];
    bucket.push(s);
    byMonth.set(key, bucket);
  }

  let invoiceCount = 0;
  let lineCount = 0;
  let returnLegs = 0;
  const months = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [monthKey, monthShipments] of months) {
    const [year, month] = monthKey.split("-").map(Number) as [number, number];
    // Invoiced in the first week of the following month, as couriers do.
    const invoiceDate = new Date(Date.UTC(year, month, 5));
    if (invoiceDate > new Date()) continue;

    const lines: InvoiceLine[] = [];
    let serial = 0;

    for (const s of monthShipments) {
      const awb = s.awbCode!;
      const shipDate = s.pickedUpAt ?? s.createdAt;
      const weight = Math.round(between(0.3, 2.4) * 10) / 10;
      // Rate card shape: a slab base plus per-500g, which is how air freight is
      // actually billed. Not a flat random number — the weight has to explain
      // the amount or the weight column is decoration.
      const base = 42 + Math.ceil(weight / 0.5) * 28;
      const fuelSurcharge = base * 0.18;
      const outbound = Math.round((base + fuelSurcharge) * 100) / 100;

      serial += 1;
      lines.push({
        awb,
        shipDate,
        destination: pick(INDIAN_CITIES),
        serviceType: "Etail Air",
        chargedWeightKg: weight,
        amountPaise: paise(outbound),
        isReturnLeg: false,
        serialNo: serial,
      });

      // The return leg. Billed on an RTO — and this is the whole point: a
      // returned parcel is charged freight in both directions, which is why an
      // RTO costs far more than the lost margin on the order.
      if (s.status === "RTO_INITIATED" || s.status === "RTO_DELIVERED") {
        serial += 1;
        returnLegs += 1;
        lines.push({
          awb,
          // The return is billed a few days after the outbound leg.
          shipDate: new Date(shipDate.getTime() + intBetween(3, 9) * 86_400_000),
          destination: "RETURN TO ORIGIN",
          serviceType: "Etail Air (R)",
          chargedWeightKg: weight,
          // Return freight runs slightly under the outbound rate — no fuel
          // surcharge on the reverse leg in Bluedart's Etail card.
          amountPaise: paise(Math.round(base * 0.92 * 100) / 100),
          isReturnLeg: true,
          serialNo: serial,
        });
      }
    }

    // A handful of AWBs we have no shipment for. Real, common, and the only
    // signal that a courier is billing for parcels that were never booked.
    for (let i = 0; i < intBetween(2, 5); i += 1) {
      serial += 1;
      lines.push({
        awb: `8${intBetween(10_000_000, 99_999_999)}`,
        shipDate: new Date(Date.UTC(year, month - 1, intBetween(1, 27))),
        destination: pick(INDIAN_CITIES),
        serviceType: "Etail Air",
        chargedWeightKg: Math.round(between(0.5, 3) * 10) / 10,
        amountPaise: paise(Math.round(between(60, 190) * 100) / 100),
        isReturnLeg: false,
        serialNo: serial,
      });
    }

    // One credit note row per invoice — a negative amount, an overcharge the
    // courier refunded. Signed amounts are a property the freight code claims
    // to handle and has never been given a chance to.
    if (lines.length > 0) {
      const credited = lines[Math.floor(rnd() * lines.length)]!;
      serial += 1;
      lines.push({
        awb: credited.awb,
        shipDate: credited.shipDate,
        destination: "CREDIT NOTE",
        serviceType: "Weight discrepancy credit",
        chargedWeightKg: credited.chargedWeightKg,
        amountPaise: -paise(Math.round(between(20, 65) * 100) / 100),
        isReturnLeg: false,
        serialNo: serial,
      });
    }

    const summed = lines.reduce((sum, l) => sum + l.amountPaise, 0n);
    const parsed: ParsedInvoice = {
      invoiceNo: `DEMO${year}${String(month).padStart(2, "0")}R${String(intBetween(10_000, 99_999))}`,
      invoiceDate,
      customerAccount: "NDA821166",
      product: "Etail Air",
      lines,
      statedLineTotalPaise: summed,
      // The grand total is NOT the sum of the lines — it carries GST and
      // surcharges on top, which is exactly why the model stores both.
      grandTotalPaise: summed + (summed * 18n) / 100n,
      summedLinePaise: summed,
      warnings: [],
    };

    const result = await applyInvoice(target.organizationId, target.legalEntityId, connectionId, parsed, `demo-${monthKey}.pdf`);
    invoiceCount += 1;
    lineCount += result.linesParsed;
    process.stdout.write(
      `  ${parsed.invoiceNo}: ${result.linesParsed} lines, ${result.shipmentsMatched} matched, ` +
        `${result.unmatchedAwbs.length} unknown AWBs, ${result.returnLegCount} return legs\n`
    );
  }

  console.log(`  → ${invoiceCount} freight invoices, ${lineCount} lines, ${returnLegs} return legs`);
}

// ---------------------------------------------------------------------------
// 2. GATEWAY SETTLEMENT COMPOSITION
// ---------------------------------------------------------------------------
// The demo has 361 Razorpay settlements and not one settlement LINE, so the
// PAYMENT_SETTLEMENT leg has nothing to reconcile and the payout composition is
// unknowable — the exact condition the real org is in.
//
// Generated as a GoKwik-format transaction ledger and fed through the real
// parser, so the batch-balance invariant (lines must sum to the payout) is
// enforced by the same code that will meet the real export.
async function seedGatewaySettlementLines(target: Target, connectionId: string) {
  const payments = await prisma.payment.findMany({
    where: {
      organizationId: target.organizationId,
      capturedAt: { not: null },
      // Marketplace payments settle on the marketplace's own cycle and are not
      // part of a gateway payout. Including them here would put an Amazon
      // referral fee inside a Razorpay settlement.
      order: { channel: "shopify" },
    },
    select: { externalPaymentId: true, amount: true, feeAmount: true, capturedAt: true, order: { select: { externalOrderId: true } } },
    orderBy: { capturedAt: "asc" },
  });
  if (payments.length === 0) {
    console.log("  no captured payments — skipping gateway settlement lines");
    return;
  }

  // T+2, the cycle the base seeder already uses for its settlement headers.
  const byPayout = new Map<string, typeof payments>();
  for (const p of payments) {
    const settledAt = new Date(p.capturedAt!.getTime() + 2 * 86_400_000);
    if (settledAt > new Date()) continue;
    const key = settledAt.toISOString().slice(0, 10);
    const bucket = byPayout.get(key) ?? [];
    bucket.push(p);
    byPayout.set(key, bucket);
  }

  // "Merchant Order Id" is the reference column the format picks first, and it
  // resolves against Order.externalOrderId — NOT against our internal id, which
  // matches nothing. Getting this wrong is silent: every line imports and every
  // line resolves to null, which reads as "the gateway paid us for orders we do
  // not have" rather than as a seeding mistake.
  //
  // "Total Settlement" is included so the balance check has something to check.
  // Without a stated total the parser can only sum what it was given, and a
  // misread column would import clean.
  const header = [
    "Settlement UTR", "Settlement Date", "Merchant Order Id",
    "Transaction Type", "Gross Amount", "Fee", "Tax", "Net Amount", "Total Settlement",
  ].join(",");

  const body: string[] = [];
  let adjustments = 0;

  for (const [dayKey, batch] of byPayout) {
    const utr = `DEMOGAP${dayKey.replaceAll("-", "")}`;
    // Built as tuples first because the batch total has to be known before any
    // row is written — every row repeats it.
    const lines: Array<[ref: string, type: string, gross: number, fee: number, tax: number, net: number]> = [];

    for (const p of batch) {
      const gross = Number(p.amount) / 100;
      const feeTotal = Number(p.feeAmount ?? 0n) / 100;
      const tax = Math.round(feeTotal * 0.18 * 100) / 100;
      const net = Math.round((gross - feeTotal) * 100) / 100;
      lines.push([p.order?.externalOrderId ?? p.externalPaymentId ?? "", "payment", gross, Math.round((feeTotal - tax) * 100) / 100, tax, net]);
    }

    // The adjustment rows — money in the payout with no order behind it. Every
    // real gateway statement has them, and a payout whose lines do not sum to
    // its total is indistinguishable from a parsing bug, so they must be
    // modelled rather than dropped. They still need a reference: a row with no
    // identifier at all is rejected by the parser, which is correct — an
    // unlabelled deduction is not something to file silently.
    const platformFee = Math.round(between(180, 640) * 100) / 100;
    lines.push([`ADJ-PLATFORM-${dayKey}`, "commission", -platformFee, 0, 0, -platformFee]);
    adjustments += 1;

    // TDS under 194-O, withheld on marketplace-facilitated sales. Roughly
    // monthly rather than on every payout, which is how it actually appears.
    if (rnd() < 0.12) {
      const tds = Math.round(between(400, 1_800) * 100) / 100;
      lines.push([`ADJ-TDS-${dayKey}`, "tds", -tds, 0, 0, -tds]);
      adjustments += 1;
    }

    // A chargeback. Rare, material, and it is the row that makes a payout
    // smaller than the sales it supposedly paid for.
    if (rnd() < 0.05) {
      const cb = Math.round(between(900, 3_400) * 100) / 100;
      lines.push([`ADJ-CHARGEBACK-${dayKey}`, "chargeback", -cb, 0, 0, -cb]);
      adjustments += 1;
    }

    const batchTotal = Math.round(lines.reduce((sum, l) => sum + l[5], 0) * 100) / 100;
    for (const [ref, type, gross, fee, tax, net] of lines) {
      body.push([utr, dayKey, ref, type, gross.toFixed(2), fee.toFixed(2), tax.toFixed(2), net.toFixed(2), batchTotal.toFixed(2)].join(","));
    }
  }

  const rows = [header, ...body];

  const result = await ingestStatement(
    { connectionId, organizationId: target.organizationId, legalEntityId: target.legalEntityId },
    rows.join("\n"),
    GOKWIK_SETTLEMENT_STATEMENT
  );

  console.log(
    `  → ${result.batchesImported} payouts, ${result.linesImported} lines ` +
      `(${adjustments} adjustments), ${result.linesUnresolved} unresolved, ${result.rejected.length} rejected`
  );
  if (result.rejected.length > 0) {
    for (const r of result.rejected.slice(0, 3)) console.log(`     rejected ${r.batchId}: ${r.detail}`);
  }
  if (result.errors.length > 0) console.log(`     errors: ${result.errors.slice(0, 3).join("; ")}`);
}

// ---------------------------------------------------------------------------
// 3. MARKETPLACE FEES (Amazon / Flipkart)
// ---------------------------------------------------------------------------
// The demo has 772 Amazon and 564 Flipkart orders and no marketplace connection
// at all, so those orders look like they cost nothing to sell — which is the
// single most misleading thing a marketplace P&L can say. Amazon's referral fee
// alone is 5–17% depending on category.
//
// Amazon's connector lands fees on Payment (amount = net proceeds, feeAmount =
// fees withheld), so that is where these go: the same shape the live connector
// will produce, not a parallel table invented for the demo.
async function seedMarketplaceFees(target: Target) {
  const created: Record<string, number> = {};

  for (const [channel, provider, feeRate, fixedFee] of [
    // Referral + closing + shipping, blended. Amazon India's referral fee for
    // apparel/beauty sits at 5–17%; the closing fee is a flat per-item charge.
    ["amazon", "AMAZON", 0.145, 32],
    // Flipkart's commission plus collection and fixed fee.
    ["flipkart", "FLIPKART", 0.128, 27],
  ] as const) {
    const connectionId = await demoConnection(target, provider, `demo-${channel}-seller`);

    const orders = await prisma.order.findMany({
      where: {
        organizationId: target.organizationId,
        channel,
        cancelledAt: null,
        // ONLY orders that have no payment yet. The base seeder already gave
        // some marketplace orders a gateway-style payment, and adding a second
        // one would count the same sale's cash twice — an order paid once must
        // have one receipt, whatever the fee structure on top of it.
        payments: { none: {} },
      },
      select: { id: true, externalOrderId: true, grossAmount: true, taxAmount: true, placedAt: true, paymentMode: true },
    });

    const existing = await prisma.payment.count({ where: { organizationId: target.organizationId, connectionId } });
    if (existing > 0) {
      console.log(`  ${channel}: ${existing} marketplace payments already present — skipping`);
      created[channel] = 0;
      continue;
    }

    const rows: Prisma.PaymentCreateManyInput[] = [];
    for (const o of orders) {
      const gross = o.grossAmount;
      // Fee is charged on the order value including tax, which is how both
      // marketplaces state it.
      const feeMinor = BigInt(Math.round(Number(gross) * feeRate)) + paise(fixedFee);
      const gstOnFee = (feeMinor * 18n) / 100n;
      const totalFee = feeMinor + gstOnFee;
      // Marketplaces settle on a ~7-day cycle, not T+2.
      const settledAt = new Date(o.placedAt.getTime() + intBetween(6, 11) * 86_400_000);
      if (settledAt > new Date()) continue;

      rows.push({
        organizationId: target.organizationId,
        legalEntityId: target.legalEntityId,
        connectionId,
        orderId: o.id,
        externalPaymentId: `${channel.slice(0, 3).toUpperCase()}-${o.externalOrderId}`,
        amount: gross - totalFee,
        feeAmount: totalFee,
        taxAmount: gstOnFee,
        currency: "INR",
        method: o.paymentMode === "COD" ? "cod" : "marketplace",
        status: "captured",
        capturedAt: settledAt,
        raw: {
          marketplace: channel,
          order_id: o.externalOrderId,
          // The fee breakdown, itemised the way the marketplace states it —
          // a single blended number would make the layer impossible to explain.
          fees: {
            referral_fee: Math.round(Number(gross) * feeRate) / 100,
            closing_fee: fixedFee,
            gst_on_fees: Number(gstOnFee) / 100,
          },
          settlement_cycle: "weekly",
        },
      });
    }

    if (rows.length > 0) {
      for (let i = 0; i < rows.length; i += 500) {
        await prisma.payment.createMany({ data: rows.slice(i, i + 500), skipDuplicates: true });
      }
    }
    created[channel] = rows.length;
    console.log(`  ${channel}: ${rows.length} marketplace payments with itemised fees`);
  }

  console.log(`  → ${Object.values(created).reduce((a, b) => a + b, 0)} marketplace fee-bearing payments`);
}

// ---------------------------------------------------------------------------
// 4. PACKAGING RATE (§23)
// ---------------------------------------------------------------------------
// The only cost layer with no ingested source at all — no connected system
// reports what a mailer costs. A founder types it once. Set here so the demo
// exercises a configured layer rather than permanently showing the
// not-configured state, which is already visible on the real org.
//
// ₹14 per parcel (poly mailer, label, tape) and ₹4 per item (tissue, insert)
// are ordinary Indian D2C numbers.
async function seedPackagingRate(target: Target) {
  const org = await prisma.organization.findUnique({
    where: { id: target.organizationId },
    select: { settings: true },
  });
  const settings = (org?.settings as Record<string, unknown> | null) ?? {};
  if (settings.packagingCost) {
    console.log("  packaging rate already configured — leaving it alone");
    return;
  }
  await prisma.organization.update({
    where: { id: target.organizationId },
    data: { settings: { ...settings, packagingCost: { perOrderPaise: "1400", perItemPaise: "400" } } },
  });
  console.log("  → ₹14.00/order + ₹4.00/item");
}

// ---------------------------------------------------------------------------
async function main() {
  if (!ORG_QUERY) {
    console.error('Usage: npx tsx scripts/seedDemoGaps.ts --org "DEMO — technox pvt ltd" [--purge]');
    process.exit(1);
  }

  const target = await resolveTarget(ORG_QUERY);
  console.log(`\ntarget: ${target.organizationName} (${target.organizationId})\n`);

  if (PURGE) {
    await purge(target);
    await prisma.$disconnect();
    return;
  }

  const bluedartConn = await demoConnection(target, "BLUEDART", "demo-NDA821166");
  const gokwikConn = await demoConnection(target, "GOKWIK", "demo-gokwik");

  console.log("[1] courier freight invoices (D5)");
  await seedFreightInvoices(target, bluedartConn);

  console.log("\n[2] gateway settlement composition");
  await seedGatewaySettlementLines(target, gokwikConn);

  console.log("\n[3] marketplace fees");
  await seedMarketplaceFees(target);

  console.log("\n[4] packaging rate");
  await seedPackagingRate(target);

  console.log("\ndone.\n");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await prisma.$disconnect();
  process.exit(1);
});
