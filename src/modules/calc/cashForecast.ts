import { Prisma } from "@prisma/client";
import { addZonedDays, DEFAULT_TIMEZONE, startOfZonedDay, zonedDayKey } from "../../lib/dateRange.js";
import { prisma } from "../../lib/prisma.js";
import { getOrgSettings } from "../orgs/settings.js";
import { formatInr, paiseToRupees } from "./money.js";
import { getAvailableCashSummary } from "./cash.js";
import { expandSchedule } from "./recurringOutflows.js";

// Cash forecast over a 7, 30 or 90-day horizon (§16).
//
// A forecast is the one number on this dashboard that cannot be verified
// against a source, so it is also the easiest one to fake convincingly. The
// rule this file holds to is that every component declares its OWN basis —
// measured, assumed, or unavailable — and the projection refuses to describe
// itself as a balance when a whole side of the equation has no data behind it.
//
// ONE engine, one horizon parameter — not three code paths. The horizon
// changes how far the same walk runs, nothing else, so a 90-day line and a
// 7-day line can never be computed differently and disagree on their
// overlapping days.
//
// The horizon is NOT free of consequences for honesty, though, and the
// engine says so rather than leaving the reader to work it out: only about
// the first `codRemittanceLagDays` of inflow come from orders that actually
// exist. Past that point every rupee of inflow is projected from trailing
// velocity, so a 90-day line is ~90% invention by value where a 7-day line is
// mostly pipeline. `projectedInflowSharePct` reports exactly that, and the
// reliability note degrades with it.
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
//
// Outflow has three parts, and P2.2e made the split explicit on every day:
//   - vendor bills:  a dated amount from a real unpaid bill
//   - recurring schedule: payroll/rent/EMI on the day the founder says they
//     leave (P2.2e), because a month of rent is a DATE, not a rate
//   - run-rate:      everything else, smeared evenly from measured history
// They are carried separately because they behave differently under a
// scenario: a bill can be deferred by asking, payroll cannot.

// v3: every ForecastDay now carries its outflow split three ways
// (bills / recurring schedule / run-rate), and the recurring schedule from
// P2.2e participates in the walk. Additive on the response — no existing field
// changed meaning — but the day shape grew, so v2 readers stay valid and v2
// snapshots stay as they are (§92).
// v4 (2026-08-13, §92): COD inflow is now REDUCED by the measured RTO rate.
// v3 reported a cod_rto_risk component with basis "measured" and a note saying
// returned orders "can be excluded" while excluding nothing — the forecast
// promised cash that never arrives. Every projected COD rupee changes, so a v3
// line must not be compared against a v4 one.
export const CASH_FORECAST_VERSION = "v4";

// The three §16 horizons. A closed set rather than a free integer: each one
// is a different QUESTION (this week's squeeze, this month's plan, this
// quarter's runway) with a different honesty profile, and an arbitrary
// 43-day horizon is not a question anyone on this product asks.
export const FORECAST_HORIZONS = [7, 30, 90] as const;
export type ForecastHorizon = (typeof FORECAST_HORIZONS)[number];
export const DEFAULT_HORIZON: ForecastHorizon = 30;

export function isForecastHorizon(n: unknown): n is ForecastHorizon {
  return typeof n === "number" && (FORECAST_HORIZONS as readonly number[]).includes(n);
}

// How far back to measure order velocity. Four weeks is long enough to average
// out a single bad week and short enough to still track a real trend; it is
// also exactly four of each weekday, which is what the day-of-week shape below
// needs to mean anything.
const VELOCITY_WINDOW_DAYS = 28;

// Day-of-week shape is measured over a longer window than the level, because a
// weekday multiplier needs more than four observations per day to be stable.
const SEASONALITY_WINDOW_DAYS = 56;
const MIN_DAYS_FOR_SEASONALITY = 28;
/**
 * Below this many dispatched COD parcels the RTO ratio is noise, not a rate,
 * and the forecast says the risk is unmeasured rather than applying it.
 * 50 is deliberately low — a brand doing 50 COD parcels a quarter still has a
 * real RTO problem worth reflecting — but high enough that one early return
 * cannot move the horizon.
 */
const MIN_COD_SHIPMENTS_FOR_RTO_RATE = 50;
/** How far back the RTO rate is measured. Long enough to cover the return leg. */
const RTO_RATE_WINDOW_DAYS = 90;

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
  /**
   * Outflow split three ways, summing to outflowMinor.
   *
   * Carried per-day rather than as a total because the scenario engine has to
   * tell them apart: `vendorPaymentDelayDays` moves bills and must not move
   * payroll. Before this existed the scenario inferred "bill" as whatever
   * exceeded the flat run-rate on a day — which was a documented
   * approximation, and became an outright bug the moment a scheduled ₹4L
   * salary made a day lumpy.
   */
  outflowFromBillsMinor: string;
  outflowFromScheduleMinor: string;
  outflowFromRunRateMinor: string;
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
  /**
   * §16. The trough, not the endpoint — a line that dips below zero in week
   * three and recovers by week twelve ends healthy and is still a crisis, so
   * the closing balance alone cannot answer "will I run out".
   */
  lowestBalance: {
    valueMinor: string;
    value: number;
    date: string;
  };
  /**
   * The first day the projected balance goes negative, or null if it never
   * does inside the horizon. Null means "not within these N days" — NOT
   * "never", which is a claim no horizon can support.
   */
  cashShortageDate: string | null;
  /**
   * What share of projected INFLOW comes from orders that don't exist yet.
   * Rises with the horizon by construction (see the header): a reader
   * deciding how much to trust the line needs this, and it is not derivable
   * from anything else in the response.
   */
  projectedInflowSharePct: number;
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
/**
 * The share of dispatched COD parcels that come back undelivered, measured.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS: THE FORECAST WAS CLAIMING TO DO SOMETHING IT DID NOT
 * ---------------------------------------------------------------------------
 * The `cod_rto_risk` component reported basis "measured" the moment an org had
 * any shipment row at all, with the note "Courier data is connected, so
 * returned COD orders can be excluded" — and nothing anywhere excluded
 * anything. valueMinor was the literal string "0", and the horizon walk applied
 * no reduction to either the placed pipeline or the projected COD inflow.
 *
 * An RTO'd COD order is not refunded — no cash was ever collected — so
 * `grossAmount - refundedAmount` does not catch it either. The forecast was
 * therefore promising cash that will never arrive, and labelling the promise
 * measured. For a tool whose output is runway, overstating cash is the
 * dangerous direction, and §42.8 forbids exactly this: an assumption dressed
 * as a measurement.
 *
 * Returns null when there is nothing to measure from, so the caller can say so
 * rather than substitute a plausible-looking default.
 */
async function measureCodRtoRate(organizationId: string, since: Date): Promise<number | null> {
  // COD parcels only. A prepaid RTO is a refund, which the revenue side
  // already accounts for — folding it in here would reduce COD inflow for
  // returns that never touched COD.
  const rows = await prisma.$queryRaw<{ dispatched: bigint; returned: bigint }[]>(Prisma.sql`
    SELECT count(*) FILTER (WHERE s."awbCode" IS NOT NULL)::bigint AS dispatched,
           count(*) FILTER (WHERE s.status IN ('RTO_INITIATED', 'RTO_DELIVERED'))::bigint AS returned
    FROM shipments s
    JOIN orders o ON o.id = s."orderId"
    WHERE s."organizationId" = ${organizationId}
      AND o."paymentMode" = 'COD'
      AND o."cancelledAt" IS NULL
      AND coalesce(s."pickedUpAt", s."createdAt") >= ${since}`);

  const dispatched = Number(rows[0]?.dispatched ?? 0n);
  const returned = Number(rows[0]?.returned ?? 0n);
  // A handful of parcels is a ratio, not a rate. Applying 1/3 from three
  // shipments would swing the forecast on noise.
  if (dispatched < MIN_COD_SHIPMENTS_FOR_RTO_RATE) return null;
  return returned / dispatched;
}

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
  now: Date = new Date(),
  horizonDays: ForecastHorizon = DEFAULT_HORIZON
): Promise<CashForecast> {
  const today = zonedDayKey(now, timeZone);
  const horizon = Array.from({ length: horizonDays }, (_, i) => addZonedDays(today, i + 1));
  const horizonEnd = startOfZonedDay(addZonedDays(today, horizonDays + 1), timeZone);

  // --- Opening balance --------------------------------------------------
  const cash = await getAvailableCashSummary(organizationId);
  const hasOpeningBalance = cash.connections.length > 0;
  const openingBalance = hasOpeningBalance ? BigInt(cash.valueMinor) : 0n;

  // --- Measured history -------------------------------------------------
  const historyFrom = startOfZonedDay(addZonedDays(today, -SEASONALITY_WINDOW_DAYS), timeZone);
  const history = await dailyOrderValues(organizationId, historyFrom, now, timeZone);

  // Measured BEFORE the inflow is assembled, because both the placed pipeline
  // and the projection have to be reduced by it — reducing only one would make
  // the forecast step at the pipeline/projection boundary.
  const codRtoRate = await measureCodRtoRate(
    organizationId,
    startOfZonedDay(addZonedDays(today, -RTO_RATE_WINDOW_DAYS), timeZone)
  );
  // Null = not measurable. Collect the full COD amount and say so, rather than
  // invent a rate; the component note already tells the reader the number is
  // optimistic in that case.
  const codCollectionRate = codRtoRate === null ? 1 : 1 - codRtoRate;
  /** COD cash actually expected, after parcels that will come back. */
  let codRtoWithheldMinor = 0n;
  const collectableCod = (amount: bigint) => {
    if (codRtoRate === null) return amount;
    const kept = (amount * BigInt(Math.round(codCollectionRate * 10_000))) / 10_000n;
    codRtoWithheldMinor += amount - kept;
    return kept;
  };

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
    addInflow(addZonedDays(d.day, FORECAST_ASSUMPTIONS.codRemittanceLagDays), collectableCod(d.cod));
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
  const measuredExpenseRunRate = (recentExpenses._sum.amount ?? 0n) / historyDays;
  const dailyAdRunRate = (adSpendRows._sum.spendAmount ?? 0n) / historyDays;
  const hasExpenseData = recentExpenses._count._all > 0;
  const hasAdData = adSpendRows._count._all > 0;
  const hasBillData = bills.length > 0;

  // --- P2.2e: the fixed costs that leave on a date, not as a rate ---------
  const settings = await getOrgSettings(organizationId);
  const schedule = expandSchedule(settings.recurringOutflows ?? [], today, zonedDayKey(horizonEnd, timeZone));
  const hasSchedule = (settings.recurringOutflows ?? []).length > 0;

  // The double-counting problem, and the reason this is a subtraction rather
  // than an addition.
  //
  // A founder whose accounting is connected ALREADY has payroll and rent in
  // `Expense`, so they are already inside measuredExpenseRunRate — smeared
  // across every day. Adding a schedule on top would charge the same salary
  // twice and make the forecast worse than before P2.2e. So the schedule's
  // typical-month cost is REMOVED from the run-rate and re-placed on its real
  // days: the monthly total is preserved, only its timing sharpens.
  //
  // Floored at zero. If a founder schedules more than their measured expenses
  // (common — they pay salary from a personal account, or the books are
  // incomplete), the run-rate simply goes to zero rather than negative, and
  // the displaced figure below reports how much of the schedule the run-rate
  // could not account for.
  const dailyScheduleEquivalent = schedule.monthlyEquivalentPaise / 30n;
  const dailyExpenseRunRate =
    measuredExpenseRunRate > dailyScheduleEquivalent ? measuredExpenseRunRate - dailyScheduleEquivalent : 0n;
  const displacedRunRatePerDay = measuredExpenseRunRate - dailyExpenseRunRate;

  // --- Walk the horizon -------------------------------------------------
  const days: ForecastDay[] = [];
  let running = openingBalance;
  let totalInflow = 0n;
  let totalOutflow = 0n;
  let totalPlaced = 0n;
  let totalProjected = 0n;
  let totalBills = 0n;
  let totalSchedule = 0n;
  let totalRunRate = 0n;
  // Seeded from the opening balance, not from the first projected day: if
  // today's balance is already the lowest point the horizon ever sees, that
  // IS the trough, and starting the search a day later would miss it.
  let lowestBalance = openingBalance;
  let lowestBalanceDate = today;
  let cashShortageDate: string | null = null;

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
    if (codOrigin >= today) projected += collectableCod(applyShape(dailyCod, codOrigin));

    const placed = placedInflowByDay.get(day) ?? 0n;
    const inflow = placed + projected;

    const billOutflow = billsByDay.get(day) ?? 0n;
    const scheduleOutflow = schedule.byDay.get(day) ?? 0n;
    const runRateOutflow = dailyExpenseRunRate + dailyAdRunRate;
    const outflow = billOutflow + scheduleOutflow + runRateOutflow;

    const opening = running;
    running = opening + inflow - outflow;

    totalInflow += inflow;
    totalOutflow += outflow;
    totalPlaced += placed;
    totalProjected += projected;
    totalBills += billOutflow;
    totalSchedule += scheduleOutflow;
    totalRunRate += runRateOutflow;

    if (running < lowestBalance) {
      lowestBalance = running;
      lowestBalanceDate = day;
    }
    // FIRST crossing only — a line that dips negative, recovers, and dips
    // again has one date that matters, and it is the earliest one.
    if (cashShortageDate === null && running < 0n) cashShortageDate = day;

    days.push({
      date: day,
      openingMinor: opening.toString(),
      inflowMinor: inflow.toString(),
      outflowMinor: outflow.toString(),
      closingMinor: running.toString(),
      inflowFromPlacedOrdersMinor: placed.toString(),
      inflowFromProjectedOrdersMinor: projected.toString(),
      outflowFromBillsMinor: billOutflow.toString(),
      outflowFromScheduleMinor: scheduleOutflow.toString(),
      outflowFromRunRateMinor: runRateOutflow.toString(),
    });
  }

  // --- Coverage ---------------------------------------------------------
  const hasRtoData = (await prisma.shipment.count({ where: { organizationId } })) > 0;

  const scheduleCount = (settings.recurringOutflows ?? []).length;
  const scheduleNote =
    `${scheduleCount} configured cost${scheduleCount === 1 ? "" : "s"}, placed on the day each is actually paid.` +
    (displacedRunRatePerDay > 0n
      ? ` ${formatInr(displacedRunRatePerDay * 30n)} a month of this was already inside the measured expense run-rate and has been removed from it, so nothing is counted twice.`
      : hasExpenseData
        ? " None of it was found in the measured expense run-rate, so it is added on top — check that these costs are not also in your accounting feed under another name."
        : "") +
    (schedule.clampedLabels.length > 0
      ? ` ${schedule.clampedLabels.join(", ")} fall${schedule.clampedLabels.length === 1 ? "s" : ""} on a day the month does not have and land on its last day instead.`
      : "");

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
      // "measured" only when a rate was actually measured AND applied. This
      // used to read `hasRtoData ? "measured" : "unavailable"` — true the
      // moment any shipment row existed — beside a note claiming returns "can
      // be excluded" and a hard-coded value of 0, while nothing was excluded
      // anywhere. That is an assumption wearing a measurement's label, which
      // is the one thing §42.8 forbids outright.
      basis: codRtoRate === null ? "unavailable" : "measured",
      // The rupees actually removed from the horizon, not a placeholder.
      valueMinor: codRtoWithheldMinor.toString(),
      note:
        codRtoRate === null
          ? hasRtoData
            ? `Fewer than ${MIN_COD_SHIPMENTS_FOR_RTO_RATE} COD parcels dispatched in ${RTO_RATE_WINDOW_DAYS} days, so the return rate would be noise rather than a rate. COD inflow is NOT reduced, and real collection will be lower than shown.`
            : "No courier connected, so COD inflow is NOT reduced for orders that will be returned undelivered. Real COD collection will be lower than shown."
          : `${(codRtoRate * 100).toFixed(1)}% of COD parcels dispatched in the last ${RTO_RATE_WINDOW_DAYS} days came back undelivered. That share has been removed from COD inflow — an RTO'd COD order collects nothing and is never refunded, so it would otherwise sit in the forecast as cash that never arrives.`,
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
      key: "outflow_recurring_schedule",
      label: "Payroll, rent and other fixed costs",
      // "assumed" rather than "measured": a founder typed these. They are far
      // better than nothing — and better than a smear — but nothing verified
      // them against a bank debit, and §42.8 does not let a typed figure wear
      // the same badge as an ingested one.
      basis: hasSchedule ? "assumed" : "unavailable",
      valueMinor: totalSchedule.toString(),
      note: !hasSchedule
        ? "No recurring-cost schedule configured. Salary, rent and EMI leave the account on fixed dates; without them this projection shows the days they happen as no worse than any other."
        : scheduleNote,
    },
    {
      key: "outflow_run_rate",
      label: "Operating spend and ads",
      basis: hasExpenseData || hasAdData ? "measured" : "unavailable",
      valueMinor: totalRunRate.toString(),
      note:
        hasExpenseData || hasAdData
          ? displacedRunRatePerDay > 0n
            ? `Daily run-rate from measured spend, less ${formatInr(displacedRunRatePerDay * 30n)} a month already covered by the recurring schedule above — counted once, on its real dates, instead of twice.`
            : "Daily run-rate from measured spend over the trailing period. A rate, not a payment schedule."
          : "No accounting or ads connection, so ad spend and ad-hoc operating costs are missing from this projection.",
    },
  ];

  // A configured schedule counts as an outflow source in its own right. For an
  // org with no accounting connection it is the ONLY one — and a forecast that
  // knows ₹4L of payroll leaves on the 1st is emphatically not "inflows only",
  // which is the badge that tells a reader the line is not a balance at all.
  const hasAnyOutflow = hasBillData || hasExpenseData || hasAdData || hasSchedule;
  const reliability = !hasAnyOutflow
    ? ("inflows_only" as const)
    : (hasBillData || hasSchedule) && (hasExpenseData || hasAdData || hasSchedule) && hasOpeningBalance
      ? ("usable" as const)
      : ("directional" as const);

  // Share of inflow that comes from orders which do not exist yet. Integer
  // maths on paise, then one division at the end — the same discipline every
  // money value in this file keeps.
  const projectedInflowSharePct =
    totalInflow === 0n ? 0 : Math.round(Number((totalProjected * 1000n) / totalInflow)) / 10;

  const baseNote =
    reliability === "inflows_only"
      ? "No outflow source is connected — no accounting system, no ad account. This line shows money coming IN and nothing going out, so it is not a cash balance and will rise indefinitely. Connect accounting or ads before treating it as a runway."
      : reliability === "directional"
        ? "Part of the outflow side is missing, so the shape of this line is more trustworthy than its level."
        : "Both sides of the projection have a real data source.";

  // The horizon's own caveat, stated separately because it is true regardless
  // of how many sources are connected: a longer horizon is not the same
  // forecast drawn further, it is a progressively larger share of pure
  // projection. Without this a 90-day line looks exactly as solid as a 7-day
  // one, and they are not remotely the same claim.
  const horizonNote =
    projectedInflowSharePct >= 66
      ? ` Over ${horizonDays} days, ${projectedInflowSharePct}% of projected inflow comes from orders not yet placed — this is a trend extrapolation, not a view of money already earned.`
      : projectedInflowSharePct >= 33
        ? ` Over ${horizonDays} days, ${projectedInflowSharePct}% of projected inflow comes from orders not yet placed.`
        : ` Most inflow over these ${horizonDays} days comes from orders already placed.`;

  // P2.2e's missing-schedule warning, and it is scoped to 30- and 90-day
  // horizons on purpose. Over 7 days a fixed cost either falls inside the
  // window or it doesn't, and a founder can see for themselves. Over 30 or 90
  // days payroll lands one or three times for certain — so a line without a
  // schedule is not merely imprecise, it is missing a known, dated, and
  // usually the largest single outflow the business has. The two cases are
  // worded differently because they are different failures: nothing at all,
  // versus a real total smeared into a shape that hides the squeeze.
  const scheduleWarning =
    hasSchedule || horizonDays < 30
      ? ""
      : hasExpenseData
        ? ` No recurring-cost schedule is configured, so payroll, rent and EMI enter this ${horizonDays}-day line only as a flat daily rate. The monthly total is about right; the days they actually leave the account are not, so a squeeze around a pay date will not show up here.`
        : ` No recurring-cost schedule is configured and no accounting is connected, so payroll, rent, EMI and tax appear NOWHERE in this ${horizonDays}-day projection. Add them in Settings before reading this line as a runway.`;

  const reliabilityNote = baseNote + horizonNote + scheduleWarning;

  return {
    version: CASH_FORECAST_VERSION,
    generatedAt: now.toISOString(),
    timezone: timeZone,
    horizonDays,
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
    lowestBalance: {
      valueMinor: lowestBalance.toString(),
      value: paiseToRupees(lowestBalance),
      date: lowestBalanceDate,
    },
    cashShortageDate,
    projectedInflowSharePct,
    components,
    reliability,
    reliabilityNote,
    assumptions: { ...FORECAST_ASSUMPTIONS, velocityWindowDays: VELOCITY_WINDOW_DAYS },
  };
}
