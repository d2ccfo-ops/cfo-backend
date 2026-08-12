import { addZonedDays, DEFAULT_TIMEZONE } from "../../lib/dateRange.js";
import {
  DEFAULT_HORIZON,
  FORECAST_ASSUMPTIONS,
  getCashForecast,
  type CashForecast,
  type ForecastDay,
  type ForecastHorizon,
} from "./cashForecast.js";
import { paiseToRupees } from "./money.js";

// §16 scenario engine — "what if?" over the base forecast.
//
// DETERMINISTIC AND A PURE TRANSFORM. Two properties, both load-bearing:
//
//   1. No LLM, no randomness, no sampling. The same parameters over the same
//      base always produce the same line, so a founder who reruns a scenario
//      after lunch sees what they saw before lunch, and a number they act on
//      can be reproduced later when someone asks where it came from.
//
//   2. It transforms the BASE FORECAST rather than re-querying. The base is
//      computed once and every scenario is applied to that same object, so a
//      scenario line and the base line it is compared against are guaranteed
//      to share an opening balance, a horizon, and a set of dates. Recomputing
//      from the database per scenario would let the two drift apart between
//      calls (a new order lands mid-comparison) and produce a "difference"
//      that is partly just elapsed time.
//
// WHAT A SCENARIO CANNOT DO: it cannot make the underlying data better. A
// forecast whose outflow side is unconnected is `inflows_only`, and every
// scenario built on it is equally unusable — the reliability and the
// component bases pass through untouched, and `warnings` says plainly which
// levers had nothing to act on.

export const CASH_SCENARIO_VERSION = "v1";

/**
 * All optional. An empty object is a valid scenario and returns the base
 * forecast unchanged — which is the correct answer to "what if nothing
 * changes", and makes the no-op case testable rather than special.
 */
export interface ScenarioParams {
  /** Ad spend up/down by this %, applied to the measured daily ad run-rate. */
  adSpendDeltaPct?: number;
  /** Shift of the prepaid/COD mix, in percentage points of order value. */
  codShareDeltaPct?: number;
  /** RTO rate change in percentage points — COD that never converts to cash. */
  rtoDeltaPct?: number;
  /** Collect receivables this many days sooner (negative = later). */
  collectionAccelDays?: number;
  /** A one-off stock purchase landing on a named day. */
  inventoryPurchase?: { amountPaise: string; date: string };
  /** Push every vendor bill this many days later. */
  vendorPaymentDelayDays?: number;
  /** Order growth up/down by this %, applied to projected (not placed) inflow. */
  growthDeltaPct?: number;
}

export interface ScenarioComparison {
  closingMinor: string;
  closingDeltaMinor: string;
  lowestBalanceMinor: string;
  lowestBalanceDeltaMinor: string;
  /** Base and scenario shortage dates, so a scenario that CAUSES one is visible. */
  baseCashShortageDate: string | null;
  scenarioCashShortageDate: string | null;
}

export interface CashScenario extends CashForecast {
  scenarioVersion: string;
  params: ScenarioParams;
  /** Which levers actually moved anything, and which were inert and why. */
  appliedLevers: Array<{ key: keyof ScenarioParams; applied: boolean; note: string }>;
  comparison: ScenarioComparison;
}

// Percentage applied to a paise amount without ever leaving integer maths —
// scaled by 10,000 so a delta of 12.34% is exact rather than a float.
function applyPct(amount: bigint, pct: number): bigint {
  const scaled = BigInt(Math.round((100 + pct) * 100));
  return (amount * scaled) / 10_000n;
}

/** Percentage POINTS of an amount, e.g. "5 points of this day's COD inflow". */
function pointsOf(amount: bigint, points: number): bigint {
  return (amount * BigInt(Math.round(points * 100))) / 10_000n;
}

function clampPct(n: number | undefined, min: number, max: number): number | undefined {
  if (n == null || !Number.isFinite(n)) return undefined;
  return Math.min(Math.max(n, min), max);
}

/**
 * Sanitised parameters. Every lever is bounded, because these arrive from a
 * slider in a browser and an unbounded one produces a confidently-drawn line
 * with no meaning — a -400% ad spend is negative money, and a 100,000%
 * growth delta overflows the chart rather than informing anyone.
 */
export function normaliseParams(raw: ScenarioParams): ScenarioParams {
  const out: ScenarioParams = {};
  const adSpend = clampPct(raw.adSpendDeltaPct, -100, 500);
  if (adSpend != null) out.adSpendDeltaPct = adSpend;
  const growth = clampPct(raw.growthDeltaPct, -100, 500);
  if (growth != null) out.growthDeltaPct = growth;
  // Share and rate shifts are percentage POINTS, so their own range is the
  // 0-100 scale they live on, not the -100..500 a multiplier can take.
  const codShare = clampPct(raw.codShareDeltaPct, -100, 100);
  if (codShare != null) out.codShareDeltaPct = codShare;
  const rto = clampPct(raw.rtoDeltaPct, -100, 100);
  if (rto != null) out.rtoDeltaPct = rto;

  if (raw.collectionAccelDays != null && Number.isFinite(raw.collectionAccelDays)) {
    // Bounded by the longest lag the base forecast models: accelerating
    // collection by more than the COD lag itself would pull cash in before
    // the order that generates it, which is not a scenario, it is a bug.
    out.collectionAccelDays = Math.round(
      Math.min(Math.max(raw.collectionAccelDays, -30), FORECAST_ASSUMPTIONS.codRemittanceLagDays)
    );
  }
  if (raw.vendorPaymentDelayDays != null && Number.isFinite(raw.vendorPaymentDelayDays)) {
    out.vendorPaymentDelayDays = Math.round(Math.min(Math.max(raw.vendorPaymentDelayDays, -90), 90));
  }
  if (raw.inventoryPurchase) {
    const amount = BigInt(raw.inventoryPurchase.amountPaise || "0");
    if (amount > 0n && /^\d{4}-\d{2}-\d{2}$/.test(raw.inventoryPurchase.date)) {
      out.inventoryPurchase = { amountPaise: amount.toString(), date: raw.inventoryPurchase.date };
    }
  }
  return out;
}

/**
 * Apply a scenario to an already-computed base forecast.
 *
 * Exported separately from runCashScenario so it is unit-testable against a
 * hand-built base with no database at all — the levers are arithmetic, and
 * arithmetic should not need Postgres to verify.
 */
export function applyScenario(base: CashForecast, rawParams: ScenarioParams): CashScenario {
  const params = normaliseParams(rawParams);
  const opening = BigInt(base.openingBalance.valueMinor);

  // A day's projected inflow split back into its COD and prepaid halves is
  // not recoverable from the base response — ForecastDay carries the
  // placed/projected split, not the payment-mode split. So mode-dependent
  // levers (codShare, rto) act on the day's PROJECTED inflow as a whole,
  // scaled by the share they would affect. Stated in `appliedLevers` rather
  // than silently approximated.
  const hasProjected = base.days.some((d) => BigInt(d.inflowFromProjectedOrdersMinor) > 0n);
  const hasPlaced = base.days.some((d) => BigInt(d.inflowFromPlacedOrdersMinor) > 0n);

  // --- Step 1: per-day inflow/outflow adjustments -------------------------
  // Outflow is tracked in its three parts, not as one number, because the
  // levers act on different ones: ad spend scales the run-rate, a vendor delay
  // re-times bills, and the recurring schedule (P2.2e) moves for neither —
  // payroll is not deferrable by asking, and it is not an advertising decision.
  interface Working {
    date: string;
    placed: bigint;
    projected: bigint;
    bills: bigint;
    schedule: bigint;
    runRate: bigint;
    /** One-off scenario spending that belongs to no base component. */
    extra: bigint;
  }
  const outflowOf = (w: Working) => w.bills + w.schedule + w.runRate + w.extra;
  let working: Working[] = base.days.map((d) => ({
    date: d.date,
    placed: BigInt(d.inflowFromPlacedOrdersMinor),
    projected: BigInt(d.inflowFromProjectedOrdersMinor),
    bills: BigInt(d.outflowFromBillsMinor),
    schedule: BigInt(d.outflowFromScheduleMinor),
    runRate: BigInt(d.outflowFromRunRateMinor),
    extra: 0n,
  }));

  // Growth acts ONLY on projected inflow. Orders already placed are a fact;
  // no growth assumption can retroactively change what a customer bought.
  if (params.growthDeltaPct != null) {
    working = working.map((w) => ({ ...w, projected: applyPct(w.projected, params.growthDeltaPct!) }));
  }

  // codShareDeltaPct is deliberately NOT applied here. A prepaid/COD mix
  // shift is a RE-TIMING (T+3 becomes T+9), and re-timing needs the per-mode
  // split, which ForecastDay does not carry — it splits inflow by
  // placed-vs-projected, not by payment mode. Approximating it as a flat
  // reduction would put a confident number on a lever that isn't modelled.
  // It is accepted, reported as not-applied in appliedLevers, and surfaced in
  // warnings, so a caller passing it is told plainly rather than shown a line
  // that silently ignored them. rtoDeltaPct covers the cash-loss half.

  // RTO is COD that never becomes cash. Applied to projected inflow as a
  // straight percentage-point reduction (or increase, if RTO improves).
  if (params.rtoDeltaPct != null && params.rtoDeltaPct !== 0) {
    working = working.map((w) => ({ ...w, projected: w.projected - pointsOf(w.projected, params.rtoDeltaPct!) }));
  }

  // Ad spend moves the outflow run-rate. It is a % of the run-rate component,
  // not of total outflow — raising ad spend 50% must not also raise rent 50%.
  // Now applied to each day's own run-rate figure rather than to a total
  // spread back across days: P2.2e made the per-day split available, and the
  // run-rate is flat anyway, so this is exact.
  const adRunRateTotal = working.reduce((a, w) => a + w.runRate, 0n);
  if (params.adSpendDeltaPct != null && adRunRateTotal > 0n) {
    working = working.map((w) => ({ ...w, runRate: applyPct(w.runRate, params.adSpendDeltaPct!) }));
  }

  // --- Step 2: re-timing levers ------------------------------------------
  // Collection acceleration moves ALREADY-PLACED inflow earlier. Cash pulled
  // before the start of the horizon is not discarded — it lands on day one,
  // because it has still been collected, just before the window opens.
  if (params.collectionAccelDays != null && params.collectionAccelDays !== 0) {
    const byDate = new Map(working.map((w) => [w.date, w]));
    const moved = new Map<string, bigint>();
    for (const w of working) {
      if (w.placed === 0n) continue;
      const target = addZonedDays(w.date, -params.collectionAccelDays);
      const landing = byDate.has(target) ? target : target < working[0]!.date ? working[0]!.date : null;
      if (landing === null) continue; // pushed past the horizon — genuinely out of view
      moved.set(landing, (moved.get(landing) ?? 0n) + w.placed);
    }
    working = working.map((w) => ({ ...w, placed: moved.get(w.date) ?? 0n }));
  }

  // Vendor payment delay moves BILL outflow later, and ONLY bill outflow.
  //
  // This used to infer the bill part of a day as "whatever exceeds the flat
  // run-rate", because the base response carried no per-day split. That was a
  // declared approximation, and P2.2e turned it into a real bug: a scheduled
  // ₹4L payroll makes a day lumpy, and the inference would have happily
  // deferred someone's salary by 30 days on the strength of it. The base now
  // carries the split, so the shift is exact and touches nothing else.
  const billTotal = working.reduce((a, w) => a + w.bills, 0n);
  if (params.vendorPaymentDelayDays != null && params.vendorPaymentDelayDays !== 0 && billTotal > 0n) {
    const shifted = new Map<string, bigint>();
    for (const w of working) {
      if (w.bills === 0n) continue;
      const target = addZonedDays(w.date, params.vendorPaymentDelayDays);
      // A bill pushed past the horizon leaves the window — that IS the
      // scenario ("pay it next quarter"), not a rounding loss.
      if (working.some((x) => x.date === target)) shifted.set(target, (shifted.get(target) ?? 0n) + w.bills);
    }
    working = working.map((w) => ({ ...w, bills: shifted.get(w.date) ?? 0n }));
  }

  // A one-off purchase is a single outflow on a named day. Outside the
  // horizon it is simply not shown — no silent clamping onto the last day,
  // which would misplace real money by up to 89 days.
  let inventoryApplied = false;
  if (params.inventoryPurchase) {
    const { amountPaise, date } = params.inventoryPurchase;
    working = working.map((w) => {
      if (w.date !== date) return w;
      inventoryApplied = true;
      return { ...w, extra: w.extra + BigInt(amountPaise) };
    });
  }

  // --- Step 3: re-walk ----------------------------------------------------
  const days: ForecastDay[] = [];
  let running = opening;
  let totalInflow = 0n;
  let totalOutflow = 0n;
  let totalProjected = 0n;
  let lowest = opening;
  let lowestDate = base.days.length > 0 ? addZonedDays(base.days[0]!.date, -1) : base.lowestBalance.date;
  let shortage: string | null = null;

  for (const w of working) {
    // A lever can drive a day's inflow below zero (RTO above 100 points on a
    // thin day). Negative inflow is not a thing — it would be an outflow, and
    // one this engine did not model — so it floors at zero.
    const placed = w.placed < 0n ? 0n : w.placed;
    const projected = w.projected < 0n ? 0n : w.projected;
    const inflow = placed + projected;
    // Each part floors independently, then sums. Flooring only the total would
    // let a negative run-rate (ad spend cut past −100%, which normaliseParams
    // already prevents, but the invariant should not depend on that) cancel a
    // real bill and hide money that is genuinely leaving.
    const bills = w.bills < 0n ? 0n : w.bills;
    const scheduleOut = w.schedule < 0n ? 0n : w.schedule;
    const runRate = w.runRate < 0n ? 0n : w.runRate;
    const extra = w.extra < 0n ? 0n : w.extra;
    const outflow = bills + scheduleOut + runRate + extra;

    const openingOfDay = running;
    running = openingOfDay + inflow - outflow;

    totalInflow += inflow;
    totalOutflow += outflow;
    totalProjected += projected;
    if (running < lowest) {
      lowest = running;
      lowestDate = w.date;
    }
    if (shortage === null && running < 0n) shortage = w.date;

    days.push({
      date: w.date,
      openingMinor: openingOfDay.toString(),
      inflowMinor: inflow.toString(),
      outflowMinor: outflow.toString(),
      closingMinor: running.toString(),
      inflowFromPlacedOrdersMinor: placed.toString(),
      inflowFromProjectedOrdersMinor: projected.toString(),
      outflowFromBillsMinor: bills.toString(),
      outflowFromScheduleMinor: scheduleOut.toString(),
      // The one-off purchase rides here rather than getting a fourth field:
      // it IS operating outflow for the day, and adding a field to ForecastDay
      // that only a scenario can ever populate would make the base and
      // scenario shapes diverge for no reader's benefit.
      outflowFromRunRateMinor: (runRate + extra).toString(),
    });
  }

  // --- Step 4: report which levers actually did anything ------------------
  const appliedLevers: CashScenario["appliedLevers"] = [];
  const lever = (key: keyof ScenarioParams, applied: boolean, note: string) => {
    if (params[key] !== undefined) appliedLevers.push({ key, applied, note });
  };
  lever("growthDeltaPct", hasProjected, hasProjected ? "Applied to inflow from orders not yet placed." : "No projected inflow to grow — there is no order history to extrapolate from.");
  lever("rtoDeltaPct", hasProjected, hasProjected ? "Applied as a percentage-point change to projected inflow." : "No projected inflow to reduce.");
  lever(
    "codShareDeltaPct",
    false,
    "Not modelled. The base forecast reports inflow split by placed-vs-projected, not by payment mode, so a prepaid/COD mix shift cannot be re-timed without recomputing from orders — which would break the guarantee that this scenario shares the base's dates. Use rtoDeltaPct for the cash effect of more COD."
  );
  lever("adSpendDeltaPct", adRunRateTotal > 0n, adRunRateTotal > 0n ? "Applied to the measured ads and operating run-rate." : "No ads or expense data connected, so there is no run-rate to change.");
  lever("collectionAccelDays", hasPlaced, hasPlaced ? "Re-timed inflow from orders already placed." : "No inflow from already-placed orders inside this horizon to re-time.");
  lever(
    "vendorPaymentDelayDays",
    billTotal > 0n,
    billTotal > 0n
      ? "Each bill re-timed on its own due date. Payroll, rent and other scheduled fixed costs are deliberately not moved — they are not deferrable by asking a supplier."
      : "No vendor bills due inside this horizon."
  );
  lever("inventoryPurchase", inventoryApplied, inventoryApplied ? "Applied as a one-off outflow on the named day." : "The purchase date falls outside this horizon, so it is not shown. Nothing was clamped onto an adjacent day.");

  const warnings = [...(base.reliability === "inflows_only" ? ["The base forecast has no outflow source connected, so no scenario built on it is a cash balance."] : [])];
  for (const l of appliedLevers) if (!l.applied) warnings.push(`${l.key}: ${l.note}`);

  const projectedInflowSharePct = totalInflow === 0n ? 0 : Math.round(Number((totalProjected * 1000n) / totalInflow)) / 10;

  return {
    ...base,
    scenarioVersion: CASH_SCENARIO_VERSION,
    params,
    days,
    totals: {
      inflowMinor: totalInflow.toString(),
      outflowMinor: totalOutflow.toString(),
      netMinor: (totalInflow - totalOutflow).toString(),
      closingMinor: running.toString(),
    },
    lowestBalance: { valueMinor: lowest.toString(), value: paiseToRupees(lowest), date: lowestDate },
    cashShortageDate: shortage,
    projectedInflowSharePct,
    // Reliability and component bases are the BASE's and are not improved by
    // a scenario — a guess layered on unconnected data is still unconnected.
    reliabilityNote: base.reliabilityNote + (warnings.length > 0 ? ` Scenario: ${warnings.join(" ")}` : ""),
    appliedLevers,
    comparison: {
      closingMinor: running.toString(),
      closingDeltaMinor: (running - BigInt(base.totals.closingMinor)).toString(),
      lowestBalanceMinor: lowest.toString(),
      lowestBalanceDeltaMinor: (lowest - BigInt(base.lowestBalance.valueMinor)).toString(),
      baseCashShortageDate: base.cashShortageDate,
      scenarioCashShortageDate: shortage,
    },
  };
}

/** Fetch the base forecast once, then transform it. */
export async function runCashScenario(
  organizationId: string,
  params: ScenarioParams,
  timeZone: string = DEFAULT_TIMEZONE,
  horizonDays: ForecastHorizon = DEFAULT_HORIZON,
  now: Date = new Date()
): Promise<{ base: CashForecast; scenario: CashScenario }> {
  const base = await getCashForecast(organizationId, timeZone, now, horizonDays);
  return { base, scenario: applyScenario(base, params) };
}
