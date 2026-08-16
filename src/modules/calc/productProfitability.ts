import { Prisma } from "@prisma/client";
import { resolveDateRange, type ResolvedRange, describeRange } from "../../lib/dateRange.js";
import { scopeWhere, type EntityScope } from "../../lib/entityScope.js";
import { prisma } from "../../lib/prisma.js";
import { paiseToRupees } from "./money.js";

// §40 SKU profitability. The spec's full version wants units, revenue, CM
// amount, CM%, refund%, RTO%, ad spend, CAC and shipping per unit. Per-SKU RTO,
// ads and shipping still need allocation inputs that don't exist, so this
// returns the derivable subset and says which layer it stops at, rather than
// allocating from thin air.
//
// Effectively this is CM0 per SKU (§36: net revenue − product COGS), where
// "net revenue" means the same thing it means on the Revenue page (§11):
// line value, less discount, less tax, LESS REFUNDS. A products table that
// skipped refunds would rank a product by money the business gave back.
//
// THE PER-LINE ARITHMETIC RUNS IN POSTGRES. This function used to load every
// in-range order WITH every line item (two round trips, tens of thousands of
// rows) to produce a few dozen per-SKU totals. The loop is now a single SQL
// pipeline (window functions over lines partitioned by order) returning one
// row per SKU plus one headline row; everything from the per-SKU rows down —
// derivation, sorting, slicing, warnings — is the same JS as before, now
// iterating tens of rows instead of tens of thousands.
//
// Exactness notes, because this is money-path code:
//   - div(a::numeric * b::numeric, c::numeric)::bigint truncates toward zero
//     exactly as JS BigInt '/' does, and the numeric promotion removes any
//     int8 overflow risk on the multiply.
//   - Every money SUM is cast ::bigint (raw SUM over bigint is numeric, which
//     Prisma would surface as Decimal — never allowed on the money path) and
//     every count ::int.
//   - Ordering is pinned to (order id, line id) on both levels, matching the
//     orderBy the old findMany carried: the LAST line of an order absorbs the
//     §41 rounding remainder, and the FIRST line seen for a SKU names it, so
//     order is part of the definition, not a display concern.
//   - The two queries run inside one REPEATABLE READ transaction so they read
//     the same snapshot — the single findMany they replace could never
//     disagree with itself, and this preserves that.
//
// Validated by diffing every output figure (per-SKU and headline) against the
// old loop across all demo orgs and four date ranges — identical.

export const FORMULA_VERSION = "v2";

// §41 multi-item order allocation, used only where the source system does NOT
// state a line's own figures. An order's discount and tax sit at ORDER level
// for such connectors, but profitability is per SKU, so they have to be pushed
// down to the lines. Revenue-weighted is the spec's stated reasonable fallback
// and the only one available (weight- and unit-based allocation would need
// per-line weights and a policy setting).
//
// Integer maths throughout, and the LAST line absorbs the rounding remainder
// so the allocated parts always sum back to the order total exactly —
// otherwise per-SKU revenue wouldn't add up to the revenue on the Revenue
// page, which is the §1 failure all over again at a smaller scale. In SQL
// that is: every line gets the floor share div(total·value, sum), and the
// last line (rn = n_lines) gets total minus the OTHER lines' floors instead.
// The zero cases (order value 0, total 0) allocate nothing to any line,
// including the last — the CASE order below guarantees it.

interface SkuRow {
  sku_key: string;
  product_name: string;
  units: number;
  units_refunded: number;
  billed: bigint;
  discounts: bigint;
  gst: bigint;
  gross_revenue: bigint;
  refunds: bigint;
  net_revenue: bigint;
  cogs: bigint;
  costed_lines: number;
  lines: number;
}

interface HeadlineRow {
  measured_value: bigint;
  allocated_value: bigint;
  refunds_measured: bigint;
  refunds_allocated: bigint;
}

// The shared pipeline:
//   li     one row per line item of each in-range, non-cancelled order that
//          HAS lines (the JOIN reproduces the old `if (lines.length === 0)
//          continue` — zero-line orders vanish from every figure), carrying
//          per-order window values: line position, line count, order value,
//          the `measured` flag (§40: the source stated discount AND tax for
//          EVERY line), and the order's attributed (line-level) refund total.
//   shares floor shares of the order-level discount, tax and refund residual
//          per line (§41), plus the refund residual itself and the §10
//          tax-inclusive-pricing test ((orderValue − discount) > taxExclusive,
//          strict — an exclusive-pricing store deducts no tax from lines).
//   alloc  the §41 last-line remainder absorption, per allocation.
//   finals the per-line final figures the old loop computed: measured lines
//          take their own stated discount/tax, allocated lines take the §41
//          share; the refund's ex-GST portion apportions the residual by the
//          order's own gross/tax ratio (§10 — refunds are recorded
//          tax-inclusive but net revenue is tax-exclusive).
function pipelineSql(where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    li AS (
      SELECT o.id AS order_id,
             o."discountAmount" AS o_discount, o."taxAmount" AS o_tax,
             o."grossAmount" AS o_gross, o."shippingAmount" AS o_ship,
             o."refundedAmount" AS o_refunded,
             l.id AS line_id, l.sku, l."productName", l.quantity, l."totalAmount",
             l."cogsAmount", l."discountAmount" AS l_discount, l."taxAmount" AS l_tax,
             COALESCE(l."refundedAmount", 0) AS l_refund,
             COALESCE(l."refundedTaxAmount", 0) AS l_refund_tax,
             COALESCE(l."refundedQuantity", 0) AS l_refund_qty,
             ROW_NUMBER() OVER wo AS rn,
             COUNT(*) OVER wp AS n_lines,
             SUM(l."totalAmount") OVER wp AS order_value,
             BOOL_AND(l."discountAmount" IS NOT NULL AND l."taxAmount" IS NOT NULL) OVER wp AS measured,
             SUM(COALESCE(l."refundedAmount", 0)) OVER wp AS attributed
      FROM orders o
      JOIN order_line_items l ON l."orderId" = o.id
      WHERE ${where}
      WINDOW wp AS (PARTITION BY o.id), wo AS (PARTITION BY o.id ORDER BY l.id)
    ),
    shares AS (
      SELECT li.*,
             (o_refunded - attributed) AS residual,
             CASE WHEN order_value = 0 OR o_discount = 0 THEN 0::bigint
                  ELSE div(o_discount::numeric * "totalAmount"::numeric, order_value::numeric)::bigint END AS disc_floor,
             CASE WHEN order_value = 0 OR o_tax = 0 THEN 0::bigint
                  ELSE div(o_tax::numeric * "totalAmount"::numeric, order_value::numeric)::bigint END AS tax_floor,
             CASE WHEN (o_refunded - attributed) > 0 AND order_value <> 0
                  THEN div((o_refunded - attributed)::numeric * "totalAmount"::numeric, order_value::numeric)::bigint
                  ELSE 0::bigint END AS ref_floor,
             (order_value - o_discount) > (o_gross - o_ship - o_tax) AS tax_inclusive
      FROM li
    ),
    alloc AS (
      SELECT s.*,
             CASE WHEN order_value = 0 OR o_discount = 0 THEN 0::bigint
                  WHEN rn = n_lines THEN o_discount - (SUM(disc_floor) OVER wp2 - disc_floor)
                  ELSE disc_floor END AS disc_alloc,
             CASE WHEN order_value = 0 OR o_tax = 0 THEN 0::bigint
                  WHEN rn = n_lines THEN o_tax - (SUM(tax_floor) OVER wp2 - tax_floor)
                  ELSE tax_floor END AS tax_alloc,
             CASE WHEN residual <= 0 OR order_value = 0 THEN 0::bigint
                  WHEN rn = n_lines THEN residual - (SUM(ref_floor) OVER wp2 - ref_floor)
                  ELSE ref_floor END AS ref_alloc
      FROM shares s
      WINDOW wp2 AS (PARTITION BY order_id)
    ),
    finals AS (
      SELECT a.*,
             CASE WHEN measured THEN l_discount ELSE disc_alloc END AS disc_final,
             CASE WHEN NOT tax_inclusive THEN 0::bigint
                  WHEN measured THEN l_tax
                  ELSE tax_alloc END AS tax_final,
             (l_refund - l_refund_tax
               + CASE WHEN o_gross > 0
                      THEN div(ref_alloc::numeric * (o_gross - o_tax)::numeric, o_gross::numeric)::bigint
                      ELSE ref_alloc END) AS refund_ex_gst
      FROM alloc a
    )`;
}

export async function getProductProfitability(
  organizationId: string,
  range: ResolvedRange = resolveDateRange({}),
  limit = 10,
  // §12.2 (P5.6). Null means the whole organisation.
  scope: EntityScope | null = null
) {
  // The entity fragment is derived from scopeWhere()'s OUTPUT — present key →
  // filter, absent → nothing — so the single-entity no-op shortcut keeps
  // living in lib/entityScope.ts rather than being re-derived here.
  const w = scopeWhere(organizationId, scope);
  const entitySql = w.legalEntityId ? Prisma.sql` AND o."legalEntityId" = ${w.legalEntityId}` : Prisma.empty;
  const whereSql = Prisma.sql`o."organizationId" = ${organizationId}${entitySql}
    AND o."placedAt" >= ${range.from} AND o."placedAt" <= ${range.to}
    AND o."cancelledAt" IS NULL`;

  const [skuRows, headlineRows] = await prisma.$transaction(
    [
      // One row per SKU. The group key mirrors the old JS `line.sku || ...`
      // exactly — empty-string SKUs fall through to the (no SKU) label too,
      // because JS `||` is a falsy test, not a null test. product_name is the
      // first line seen for the SKU in (order id, line id) order, and the rows
      // come back in first-seen order, so the Map-insertion order the stable
      // sorts below tie-break on is the same one the old loop produced.
      prisma.$queryRaw<SkuRow[]>(Prisma.sql`
        WITH ${pipelineSql(whereSql)}
        SELECT CASE WHEN sku IS NULL OR sku = '' THEN '(no SKU) ' || "productName" ELSE sku END AS sku_key,
               (array_agg("productName" ORDER BY order_id, line_id))[1] AS product_name,
               SUM(quantity)::int AS units,
               SUM(l_refund_qty)::int AS units_refunded,
               SUM("totalAmount")::bigint AS billed,
               SUM(disc_final)::bigint AS discounts,
               SUM(tax_final)::bigint AS gst,
               SUM("totalAmount" - disc_final - tax_final)::bigint AS gross_revenue,
               SUM(refund_ex_gst)::bigint AS refunds,
               SUM("totalAmount" - disc_final - tax_final - refund_ex_gst)::bigint AS net_revenue,
               COALESCE(SUM("cogsAmount"), 0)::bigint AS cogs,
               COUNT("cogsAmount")::int AS costed_lines,
               COUNT(*)::int AS lines
        FROM finals
        GROUP BY 1
        ORDER BY (array_agg(order_id ORDER BY order_id, line_id))[1],
                 (array_agg(line_id ORDER BY order_id, line_id))[1]`),
      // §53/§110 headline: how much of the table is measured versus inferred,
      // weighted by VALUE rather than row count, so one big allocated order
      // can't hide behind a hundred small measured ones. One representative
      // row per order (rn = 1); attributed refunds count as measured
      // unconditionally, the residual only when there is one to allocate.
      prisma.$queryRaw<HeadlineRow[]>(Prisma.sql`
        WITH ${pipelineSql(whereSql)}
        SELECT COALESCE(SUM(order_value) FILTER (WHERE measured), 0)::bigint AS measured_value,
               COALESCE(SUM(order_value) FILTER (WHERE NOT measured), 0)::bigint AS allocated_value,
               COALESCE(SUM(attributed), 0)::bigint AS refunds_measured,
               COALESCE(SUM(residual) FILTER (WHERE residual > 0), 0)::bigint AS refunds_allocated
        FROM shares
        WHERE rn = 1`),
    ],
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  );

  const headline = headlineRows[0]!;
  const measuredValue = headline.measured_value;
  const allocatedValue = headline.allocated_value;
  const refundsMeasured = headline.refunds_measured;
  const refundsAllocated = headline.refunds_allocated;

  const products = skuRows.map((a) => {
    // A SKU is only profitable-or-not if EVERY one of its lines is costed.
    // Partially-costed SKUs would show inflated margin, which is exactly how a
    // loss-making product ends up in a "most profitable" table. The SQL always
    // returns the partial COGS sum; this gate is what keeps it out of the
    // response, so the costedLines/lines counters stay visible either way.
    const fullyCosted = a.lines > 0 && a.costed_lines === a.lines;
    const cm0 = fullyCosted ? a.net_revenue - a.cogs : null;
    // §13 — units net of returns, so a product returned as often as it sells
    // doesn't read as a bestseller.
    const unitsNet = a.units - a.units_refunded;
    return {
      sku: a.sku_key,
      productName: a.product_name,
      units: unitsNet,
      unitsSold: a.units,
      unitsRefunded: a.units_refunded,
      billedMinor: a.billed.toString(),
      billed: paiseToRupees(a.billed),
      discountsMinor: a.discounts.toString(),
      discounts: paiseToRupees(a.discounts),
      gstMinor: a.gst.toString(),
      gst: paiseToRupees(a.gst),
      grossRevenueMinor: a.gross_revenue.toString(),
      grossRevenue: paiseToRupees(a.gross_revenue),
      refundsMinor: a.refunds.toString(),
      refunds: paiseToRupees(a.refunds),
      refundRatePct:
        a.gross_revenue === 0n
          ? null
          : Math.round((Number(a.refunds) / Number(a.gross_revenue)) * 1000) / 10,
      netRevenueMinor: a.net_revenue.toString(),
      netRevenue: paiseToRupees(a.net_revenue),
      cogsMinor: fullyCosted ? a.cogs.toString() : null,
      cogs: fullyCosted ? paiseToRupees(a.cogs) : null,
      cm0Minor: cm0?.toString() ?? null,
      cm0: cm0 === null ? null : paiseToRupees(cm0),
      cm0Pct:
        cm0 === null || a.net_revenue === 0n
          ? null
          : Math.round((Number(cm0) / Number(a.net_revenue)) * 1000) / 10,
      costed: fullyCosted,
      costedLines: a.costed_lines,
      lines: a.lines,
    };
  });

  const costed = products.filter((p) => p.costed);
  const byMargin = [...costed].sort((a, b) => (b.cm0 ?? 0) - (a.cm0 ?? 0));
  const byRevenue = [...products].sort((a, b) => b.netRevenue - a.netRevenue);

  const totalValue = measuredValue + allocatedValue;
  const totalRefunds = refundsMeasured + refundsAllocated;
  // Rounded once and reused, so the headline percentage and the warning that
  // explains it can never disagree by a rounding step.
  const measuredValuePct =
    totalValue === 0n ? null : Math.round(Number((measuredValue * 1000n) / totalValue)) / 10;
  const refundsMeasuredPct =
    totalRefunds === 0n ? null : Math.round(Number((refundsMeasured * 1000n) / totalRefunds)) / 10;

  const warnings: string[] = [];
  if (measuredValuePct !== null && measuredValuePct < 100) {
    warnings.push(
      `${(100 - measuredValuePct).toFixed(1)}% of line value comes from a source that reports discount and tax only at order level; those lines are split by revenue weight (§41).`
    );
  }
  if (refundsMeasuredPct !== null && refundsMeasuredPct < 100) {
    warnings.push(
      `${(100 - refundsMeasuredPct).toFixed(1)}% of refund value was issued against the order rather than a named product, and is split by revenue weight (§41).`
    );
  }

  return {
    metric: "product_profitability",
    currency: "INR",
    period: { start: range.from.toISOString(), end: range.to.toISOString() },
    // Both windows, stated as days on the org calendar — a comparison that
    // will not disclose its own boundaries is asking to be trusted blind.
    window: describeRange(range),
    formulaVersion: FORMULA_VERSION,
    lastCalculatedAt: new Date().toISOString(),
    // §90 — profitability without complete COGS is not an estimate of profit.
    status: costed.length === 0 ? "INCOMPLETE" : "ESTIMATED",
    // Tells the UI which table it can honestly render: profitability rankings
    // need costs, revenue rankings don't.
    canRankByMargin: costed.length > 0,
    skuCount: products.length,
    costedSkuCount: costed.length,
    stopsAt: "CM0",
    stopsAtNote:
      "Per-SKU shipping, RTO and ad spend need allocation inputs that don't exist yet (§40 asks for them; §41 would allocate them).",
    // §110 trust layer: revenue is measured per line, not inferred, wherever
    // this is 100.
    measuredValuePct,
    refundsMeasuredPct,
    topByMargin: byMargin.slice(0, limit),
    bottomByMargin: byMargin.filter((p) => (p.cm0 ?? 0) < 0).slice(-limit).reverse(),
    topByRevenue: byRevenue.slice(0, limit),
    warnings,
  };
}
