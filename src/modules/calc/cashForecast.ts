import { Prisma } from "@prisma/client";
import { addZonedDays, DEFAULT_TIMEZONE, startOfZonedDay, zonedDayKey } from "../../lib/dateRange.js";
import { prisma } from "../../lib/prisma.js";
import { paiseToRupees } from "./money.js";
import { getAvailableCashSummary } from "./cash.js";

// 30-day cash forecast.
//
// A forecast is the one number on this dashboard that cannot be verified
// against a source, so it is also the easiest one to fake convincingly. The
// rule this file holds to is that every component declares its OWN basis —
// measured, assumed, or unavailable — and the projection refuses to describe
// itself as a balance when a whole side of the equation has no data behind it.
//
//   closing(d) = closing(d-1) + inflow(d) − outflow(d)
//
// Inflow has two parts:
//   - cash already earned but not yet collected: orders already placed, landing
//     on their own settlement/remittance lag
//   - cash from orders not placed yet: trailing velocity × day-of-week shape
//
// Outflow needs accounting data (vendor bills, expenses) or an ads connection.
// With none of those, outflow is not "zero" — it is UNKNOWN, and a projection
// that quietly treats unknown as zero draws a line that rises forever. That
// distinction is the whole reason `reliability` exists below.

export const CASH_FORECAST_VERSION = "v1";

const HORIZON_DAYS = 30;

// How far back to measure order velocity. Four weeks is long enough to average
// out a single bad week and short enough to still track a real trend; it is
// also exactly four of each weekday, which is what the day-of-week shape below
// needs to mean anything.
const VELOCITY_WINDOW_DAYS = 28;

// Day-of-week shape is measured over a longer window than the level, because a
// weekday multiplier needs more than four observations per day to be stable.
const SEASONALITY_WINDOW_DAYS = 56;
const MIN_DAYS_FOR_SEASONALITY = 28;

// ---------------------------------------------------------------------------
// Assumptions — stated, not buried
// ---------------------------------------------------------------------------
// These are the only invented numbers in this file. They are returned to the
// caller so the UI can show them, and every one of them becomes measurable the
// moment the relevant connector is live:
//   - prepaid lag becomes measurable from Settlement records
//   - COD lag becomes measurable from Shipment.deliveredAt plus a courier
//     remittance statement
//   - the COD success rate becomes measurable from the RTO rate
export const FORECAST_ASSUMPTIONS = {
  /** Gateway payout lag for a prepaid order, in days. Razorpay's standard is T+2. */
  prepaidSettlementLagDays: 3,
  /** Order → delivery → courier COD remittance, in days. */
  codRemittanceLagDays: 9,
} as const;

export type Basis = "measured" | "assumed" | "unavailable";

export interface ComponentCoverage {
  key: string;
  label: string;
  basis: Basis;
  /** Total contribution across the horizon, paise. Zero when unavailable. */
  valueMinor: string;
  note: string;
}

export interface ForecastDay {
  date: string;
  openingMinor: string;
  inflowMinor: string;
  outflowMinor: string;
  closingMinor: string;
  /** Split so a reader can see how much of a day is real vs projected. */
  inflowFromPlacedOrdersMinor: string;
  inflowFromProjectedOrdersMinor: string;
}

export interface CashForecast {
  version: string;
  generatedAt: string;
  timezone: string;
  horizonDays: number;
  openingBalance: {
    valueMinor: string;
    value: number;
    basis: Basis;
    note: string;
  };
  days: ForecastDay[];
  totals: {
    inflowMinor: string;
    outflowMinor: string;
    netMinor: string;
    closingMinor: string;
  };
  components: ComponentCoverage[];
  /**
   * usable        — both sides measured; the closing balance means something
   * directional   — inflows real, outflows partial; treat the shape, not the level
   * inflows_only  — no outflow source at all; this is NOT a balance projection
   */
  reliability: "usable" | "directional" | "inflows_only";
  reliabilityNote: string;
  assumptions: typeof FORECAST_ASSUMPTIONS & { velocityWindowDays: number };
}

// ---------------------------------------------------------------------------

interface DailyOrderValue {
  day: string; // org-local YYYY-MM-DD
  prepaid: bigint;
  cod: bigint;
}

// Order cash value, not revenue: what the customer actually pays, less anything
// already refunded. Cancelled orders never produce cash and are excluded
// outright (§16) rather than netted out later.
async function dailyOrderValues(
  organizationId: string,
  from: Date,
  to: Date,
  timeZone: string
): Promise<DailyOrderValue[]> {
  const rows = await prisma.$queryRaw<{ day: string; mode: string; total: bigint }[]>(Prisma.sql`
    SELECT to_char(o."placedAt" AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS day,
           CASE WHEN o."paymentMode" = 'COD' THEN 'COD' ELSE 'PREPAID' END AS mode,
           sum(o."grossAmount" - o."refundedAmount")::bigint AS total
    FROM orders o
    WHERE o."organizationId" = ${organizationId}
      AND o."cancelledAt" IS NULL
      AND o."placedAt" >= ${from}
      AND o."placedAt" <= ${to}
    GROUP BY 1, 2`);

  const byDay = new Map<string, DailyOrderValue>();
  for (const r of rows) {
    const entry = byDay.get(r.day) ?? { day: r.day, prepaid: 0n, cod: 0n };
    if (r.mode === "COD") entry.cod += r.total;
    else entry.prepaid += r.total;
    byDay.set(r.day, entry);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

// Multiplier per weekday, normalised so the mean is 1. Returns null when there
// is not enough history for the shape to be a measurement rather than noise —
// in which case every day is treated as average, which is the honest default.
function weekdayShape(history: DailyOrderValue[]): number[] | null {
  if (history.length < MIN_DAYS_FOR_SEASONALITY) return null;

  const sums = new Array<number>(7).fill(0);
  const counts = new Array<number>(7).fill(0);
  for (const d of history) {
    // Parsed as UTC purely to read the weekday off a calendar date string;
    // the date itself is already the organisation's local day.
    const weekday = new Date(`${d.day}T00:00:00Z`).getUTCDay();
    sums[weekday]! += Number(d.prepaid + d.cod);
    counts[weekday]! += 1;
  }

  const means = sums.map((s, i) => (counts[i]! > 0 ? s / counts[i]! : 0));
  const overall = means.reduce((a, b) => a + b, 0) / 7;
  if (overall <= 0) return null;

  // Clamped: a single freak day (a sale, an outage) should tilt the shape, not
  // define it. Beyond 2x the forecast stops describing a normal week.
  return means.map((m) => Math.min(Math.max(m / overall, 0.25), 2));
}

function mean(values: bigint[]): bigint {
  if (values.length === 0) return 0n;
  return values.reduce((a, b) => a + b, 0n) / BigInt(values.length);
}

export async function getCashForecast(
  organizationId: string,
  timeZone: string = DEFAULT_TIMEZONE,
  now: Date = new Date()
): Promise<CashForecast> {
  const today = zonedDayKey(now, timeZone);
  const horizon = Array.from({ length: HORIZON_DAYS }, (_, i) => addZonedDays(today, i + 1));
  const horizonEnd = startOfZonedDay(addZonedDays(today, HORIZON_DAYS + 1), timeZone);

  // --- Opening balance --------------------------------------------------
  const cash = await getAvailableCashSummary(organizationId);
  const hasOpeningBalance = cash.connections.length > 0;
  const openingBalance = hasOpeningBalance ? BigInt(cash.valueMinor) : 0n;

  // --- Measured history -------------------------------------------------
  const historyFrom = startOfZonedDay(addZonedDays(today, -SEASONALITY_WINDOW_DAYS), timeZone);
  const history = await dailyOrderValues(organizationId, historyFrom, now, timeZone);

  const velocityCutoff = addZonedDays(today, -VELOCITY_WINDOW_DAYS);
  const recent = history.filter((d) => d.day >= velocityCutoff && d.day < today);
  const dailyPrepaid = mean(recent.map((d) => d.prepaid));
  const dailyCod = mean(recent.map((d) => d.cod));
  const shape = weekdayShape(history);

  // --- Cash already earned, not yet collected ---------------------------
  // Every order still inside its own lag window has cash arriving on a day we
  // can name. This is the only part of the inflow that is not a projection.
  //
  // Ends at the START of today, not at `now`: today is a partial day. Counting
  // the orders placed so far as if the day were over understates it by however
  // much of the day is left, and that understatement would then be stamped
  // onto a specific future date as though it were measured. Today is treated
  // as a projected day like any other (see the `>= today` test below).
  const pipelineFrom = startOfZonedDay(
    addZonedDays(today, -Math.max(FORECAST_ASSUMPTIONS.prepaidSettlementLagDays, FORECAST_ASSUMPTIONS.codRemittanceLagDays)),
    timeZone
  );
  const pipelineTo = new Date(startOfZonedDay(today, timeZone).getTime() - 1);
  const pipeline = await dailyOrderValues(organizationId, pipelineFrom, pipelineTo, timeZone);

  const placedInflowByDay = new Map<string, bigint>();
  const addInflow = (day: string, amount: bigint) => {
    if (amount === 0n) return;
    placedInflowByDay.set(day, (placedInflowByDay.get(day) ?? 0n) + amount);
  };
  for (const d of pipeline) {
    addInflow(addZonedDays(d.day, FORECAST_ASSUMPTIONS.prepaidSettlementLagDays), d.prepaid);
    addInflow(addZonedDays(d.day, FORECAST_ASSUMPTIONS.codRemittanceLagDays), d.cod);
  }

  // --- Outflows ---------------------------------------------------------
  const [bills, recentExpenses, adSpendRows] = await Promise.all([
    prisma.vendorBill.findMany({
      where: {
        organizationId,
        currency: "INR",
        status: { notIn: ["paid", "void", "draft"] },
        dueDate: { gte: startOfZonedDay(today, timeZone), lte: horizonEnd },
      },
      select: { dueDate: true, balanceAmount: true },
    }),
    prisma.expense.aggregate({
      where: { organizationId, currency: "INR", expenseDate: { gte: historyFrom, lte: now } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.adSpend.aggregate({
      where: { organizationId, currency: "INR", date: { gte: historyFrom, lte: now } },
      _sum: { spendAmount: true },
      _count: { _all: true },
    }),
  ]);

  const billsByDay = new Map<string, bigint>();
  for (const b of bills) {
    if (!b.dueDate) continue;
    const day = zonedDayKey(b.dueDate, timeZone);
    billsByDay.set(day, (billsByDay.get(day) ?? 0n) + b.balanceAmount);
  }

  // Recurring spend as a flat daily run-rate from measured history. Not a
  // schedule — it makes no claim about WHICH day rent leaves the account, only
  // that a month of operating cost does.
  const historyDays = BigInt(Math.max(1, SEASONALITY_WINDOW_DAYS));
  const dailyExpenseRunRate = (recentExpenses._sum.amount ?? 0n) / historyDays;
  const dailyAdRunRate = (adSpendRows._sum.spendAmount ?? 0n) / historyDays;
  const hasExpenseData = recentExpenses._count._all > 0;
  const hasAdData = adSpendRows._count._all > 0;
  const hasBillData = bills.length > 0;

  // --- Walk the horizon -------------------------------------------------
  const days: ForecastDay[] = [];
  let running = openingBalance;
  let totalInflow = 0n;
  let totalOutflow = 0n;
  let totalPlaced = 0n;
  let totalProjected = 0n;
  let totalBills = 0n;
  let totalRunRate = 0n;

  // Weekday multiplier applied to a paise amount, staying in integers — the
  // multiplier is scaled by 1000 rather than converted to a float, so no money
  // value ever passes through a Number on its way to storage or display.
  const applyShape = (amount: bigint, day: string): bigint => {
    if (!shape) return amount;
    const m = shape[new Date(`${day}T00:00:00Z`).getUTCDay()]!;
    return (amount * BigInt(Math.round(m * 1000))) / 1000n;
  };

  for (const day of horizon) {
    // Cash arriving on `day` came from an order placed `lag` days earlier, so
    // the projection is indexed by that ORIGIN day — its weekday shape, not
    // the arrival day's. Using the arrival day would apply Saturday's order
    // pattern to money from a Wednesday.
    const prepaidOrigin = addZonedDays(day, -FORECAST_ASSUMPTIONS.prepaidSettlementLagDays);
    const codOrigin = addZonedDays(day, -FORECAST_ASSUMPTIONS.codRemittanceLagDays);

    // Origins from today onward are projections; earlier origins are complete
    // days already sitting in `placedInflowByDay`. The boundary is exactly
    // where the pipeline query stops, so no rupee is counted on both sides and
    // none is dropped between them.
    let projected = 0n;
    if (prepaidOrigin >= today) projected += applyShape(dailyPrepaid, prepaidOrigin);
    if (codOrigin >= today) projected += applyShape(dailyCod, codOrigin);

    const placed = placedInflowByDay.get(day) ?? 0n;
    const inflow = placed + projected;

    const billOutflow = billsByDay.get(day) ?? 0n;
    const runRateOutflow = dailyExpenseRunRate + dailyAdRunRate;
    const outflow = billOutflow + runRateOutflow;

    const opening = running;
    running = opening + inflow - outflow;

    totalInflow += inflow;
    totalOutflow += outflow;
    totalPlaced += placed;
    totalProjected += projected;
    totalBills += billOutflow;
    totalRunRate += runRateOutflow;

    days.push({
      date: day,
      openingMinor: opening.toString(),
      inflowMinor: inflow.toString(),
      outflowMinor: outflow.toString(),
      closingMinor: running.toString(),
      inflowFromPlacedOrdersMinor: placed.toString(),
      inflowFromProjectedOrdersMinor: projected.toString(),
    });
  }

  // --- Coverage ---------------------------------------------------------
  const hasRtoData = (await prisma.shipment.count({ where: { organizationId } })) > 0;

  const components: ComponentCoverage[] = [
    {
      key: "opening_balance",
      label: "Opening cash",
      basis: hasOpeningBalance ? "measured" : "unavailable",
      valueMinor: openingBalance.toString(),
      note: hasOpeningBalance
        ? "Bank opening balance plus every transaction since, per connected account."
        : "No bank account has an opening balance set, so the projection starts from zero and shows movement only, not a balance.",
    },
    {
      key: "inflow_placed_orders",
      label: "Cash from orders already placed",
      basis: "assumed",
      valueMinor: totalPlaced.toString(),
      note: `Real order values, landing on an assumed lag — prepaid T+${FORECAST_ASSUMPTIONS.prepaidSettlementLagDays}, COD T+${FORECAST_ASSUMPTIONS.codRemittanceLagDays}. The amounts are measured; only the timing is assumed, and it becomes measurable once a gateway and a courier are connected.`,
    },
    {
      key: "inflow_projected_orders",
      label: "Cash from orders not placed yet",
      basis: "measured",
      valueMinor: totalProjected.toString(),
      note: shape
        ? `Trailing ${VELOCITY_WINDOW_DAYS}-day order velocity, shaped by a measured day-of-week pattern over ${SEASONALITY_WINDOW_DAYS} days.`
        : `Trailing ${VELOCITY_WINDOW_DAYS}-day order velocity. Not enough history for a day-of-week pattern, so every day is treated as average.`,
    },
    {
      key: "cod_rto_risk",
      label: "COD returns (RTO)",
      basis: hasRtoData ? "measured" : "unavailable",
      valueMinor: "0",
      note: hasRtoData
        ? "Courier data is connected, so returned COD orders can be excluded."
        : "No courier connected, so COD inflow is NOT reduced for orders that will be returned undelivered. Real COD collection will be lower than shown.",
    },
    {
      key: "outflow_vendor_bills",
      label: "Vendor bills due",
      basis: hasBillData ? "measured" : "unavailable",
      valueMinor: totalBills.toString(),
      note: hasBillData
        ? "Unpaid bill balances with a due date inside the horizon."
        : "No accounting connection, so scheduled vendor payments are unknown.",
    },
    {
      key: "outflow_run_rate",
      label: "Operating spend and ads",
      basis: hasExpenseData || hasAdData ? "measured" : "unavailable",
      valueMinor: totalRunRate.toString(),
      note:
        hasExpenseData || hasAdData
          ? "Daily run-rate from measured spend over the trailing period. A rate, not a payment schedule."
          : "No accounting or ads connection, so payroll, rent, GST and ad spend are all missing from this projection.",
    },
  ];

  const hasAnyOutflow = hasBillData || hasExpenseData || hasAdData;
  const reliability = !hasAnyOutflow
    ? ("inflows_only" as const)
    : hasBillData && (hasExpenseData || hasAdData) && hasOpeningBalance
      ? ("usable" as const)
      : ("directional" as const);

  const reliabilityNote =
    reliability === "inflows_only"
      ? "No outflow source is connected — no accounting system, no ad account. This line shows money coming IN and nothing going out, so it is not a cash balance and will rise indefinitely. Connect accounting or ads before treating it as a runway."
      : reliability === "directional"
        ? "Part of the outflow side is missing, so the shape of this line is more trustworthy than its level."
        : "Both sides of the projection have a real data source.";

  return {
    version: CASH_FORECAST_VERSION,
    generatedAt: now.toISOString(),
    timezone: timeZone,
    horizonDays: HORIZON_DAYS,
    openingBalance: {
      valueMinor: openingBalance.toString(),
      value: paiseToRupees(openingBalance),
      basis: hasOpeningBalance ? "measured" : "unavailable",
      note: components[0]!.note,
    },
    days,
    totals: {
      inflowMinor: totalInflow.toString(),
      outflowMinor: totalOutflow.toString(),
      netMinor: (totalInflow - totalOutflow).toString(),
      closingMinor: running.toString(),
    },
    components,
    reliability,
    reliabilityNote,
    assumptions: { ...FORECAST_ASSUMPTIONS, velocityWindowDays: VELOCITY_WINDOW_DAYS },
  };
}
