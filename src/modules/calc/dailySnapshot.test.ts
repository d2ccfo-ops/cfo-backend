import { describe, expect, it } from "vitest";
import {
  DAILY_SNAPSHOT_METRICS,
  RESOLVED_METRIC_KEYS,
  decideDailyRows,
  lastCompleteDay,
  observedThroughDay,
  type ConnectionObservation,
  type DailyMetricSpec,
  type DailySnapshotSources,
} from "./dailySnapshot.js";

// decideDailyRows is the half of P2.2d that decides what an organisation can
// honestly report, so it is verified here with no database — the same split
// anomalies.test.ts uses. scripts/checkDailySnapshot.ts covers the writing,
// the reading and the day arithmetic against real data.
//
// The fixture below is cast rather than constructed field-for-field: these
// twelve summaries carry several hundred fields between them and
// decideDailyRows reads twelve. What stops the cast from hiding drift is that
// gather() in dailySnapshot.ts binds the same object to the REAL return types
// of the twelve calc functions, so a renamed field is a compile error there
// before it can be a silent test pass here.

/** The last millisecond of 11 Aug 2026, IST. */
const DAY_END = new Date("2026-08-11T18:29:59.999Z");
/** Synced after the day closed — the day was observed. */
const FRESH = new Date("2026-08-12T02:00:00.000Z");
/** Synced before the day closed — the day was never observed. */
const STALE = new Date("2026-08-10T06:00:00.000Z");

const ALL_FRESH: ConnectionObservation[] = [
  { provider: "SHOPIFY", status: "ACTIVE", lastSyncedAt: FRESH },
  { provider: "BANK", status: "ACTIVE", lastSyncedAt: FRESH },
  { provider: "META_ADS", status: "ACTIVE", lastSyncedAt: FRESH },
  { provider: "SHIPROCKET", status: "ACTIVE", lastSyncedAt: FRESH },
  { provider: "ZOHO_BOOKS", status: "ACTIVE", lastSyncedAt: FRESH },
];

function sources(over: Record<string, unknown> = {}): DailySnapshotSources {
  const base = {
    connections: ALL_FRESH,
    dayEnd: DAY_END,
    availableCash: {
      valueMinor: "5000000", // ₹50,000
      connections: [{ connectionId: "c1", label: "HDFC", balanceMinor: "5000000", balance: 50000 }],
      missingOpeningBalance: [],
    },
    cashReceived: { valueMinor: "120000" },
    netRevenue: { valueMinor: "800000" },
    sales: {
      status: "ESTIMATED",
      grossSales: { valueMinor: "900000" },
      orders: { value: 42 },
    },
    adSpend: { valueMinor: "150000", dayCount: 2 },
    rto: { rtoRatePct: 8.4, dispatchedCount: 120 },
    inventory: { valueMinor: "22000000", variantCount: 310 },
    payables: { connected: true, totalOutstandingMinor: "4500000" },
    cod: { hasCourierData: true, deliveredValue: 700000n, unknownValue: 30000n },
    burn: { runwayMonths: 7.2, runwayReason: "Available cash ÷ monthly net burn." },
    contribution: { levels: { cm3: { marginPct: 11.5 } } },
  };
  return { ...base, ...over } as unknown as DailySnapshotSources;
}

const keys = (s: DailySnapshotSources) => decideDailyRows(s).rows.map((r) => r.metricKey);
const row = (s: DailySnapshotSources, key: string) => decideDailyRows(s).rows.find((r) => r.metricKey === key);
const why = (s: DailySnapshotSources, key: string) =>
  decideDailyRows(s).omitted.find((o) => o.metricKey === key)?.reason ?? "";

describe("the metric catalogue", () => {
  it("has no duplicate keys", () => {
    const seen = new Set(DAILY_SNAPSHOT_METRICS.map((m) => m.key));
    expect(seen.size).toBe(DAILY_SNAPSHOT_METRICS.length);
  });

  it("has exactly one resolver per catalogued metric", () => {
    // What stops a metric added to the catalogue from silently never being
    // captured, and a resolver left behind after a metric is removed.
    expect(new Set(RESOLVED_METRIC_KEYS)).toEqual(new Set(DAILY_SNAPSHOT_METRICS.map((m) => m.key)));
  });

  it("accounts for every metric on every run — recorded or omitted, never dropped", () => {
    for (const s of [sources(), sources({ connections: [] }), sources({ burn: { runwayMonths: null, runwayReason: "no burn" } })]) {
      const d = decideDailyRows(s);
      const covered = [...d.rows.map((r) => r.metricKey), ...d.omitted.map((o) => o.metricKey)];
      expect(new Set(covered)).toEqual(new Set(DAILY_SNAPSHOT_METRICS.map((m) => m.key)));
      expect(covered.length).toBe(DAILY_SNAPSHOT_METRICS.length);
    }
  });

  it("gives every omission a non-empty reason", () => {
    // "Omitted" with no reason is the same dead end as a silent zero: nobody
    // can tell a broken sync from a metric that never applied.
    for (const o of decideDailyRows(sources({ connections: [] })).omitted) {
      expect(o.reason.length, o.metricKey).toBeGreaterThan(0);
    }
  });

  it("writes money into valueMinor and everything else into valueNumeric", () => {
    // The failure this catches is a percentage stored in the paise column, or a
    // rupee figure in the float column — both of which render as a confident,
    // wrong number rather than as an error.
    const specs = new Map<string, DailyMetricSpec>(DAILY_SNAPSHOT_METRICS.map((m) => [m.key, m]));
    for (const r of decideDailyRows(sources()).rows) {
      const spec = specs.get(r.metricKey)!;
      if (spec.unit === "paise") {
        expect(r.valueMinor, `${r.metricKey} is money`).not.toBeNull();
        expect(r.valueNumeric, `${r.metricKey} is money`).toBeNull();
      } else {
        expect(r.valueNumeric, `${r.metricKey} is not money`).not.toBeNull();
        expect(r.valueMinor, `${r.metricKey} is not money`).toBeNull();
      }
    }
  });

  it("captures every catalogued metric when every source is fresh and every value exists", () => {
    expect(new Set(keys(sources()))).toEqual(new Set(DAILY_SNAPSHOT_METRICS.map((m) => m.key)));
  });
});

describe("a day no source observed is not recorded as zero", () => {
  it("omits everything when nothing is connected", () => {
    expect(decideDailyRows(sources({ connections: [] })).rows).toHaveLength(0);
    expect(why(sources({ connections: [] }), "net_revenue_day")).toMatch(/no order source is connected/);
  });

  it("omits the sales metrics when the order feed stopped before the day closed", () => {
    // The failure that motivated the gate: Shopify last synced two days ago,
    // the orders table is legitimately empty for yesterday, and every sales
    // query returns a well-formed ₹0 that is not a measurement.
    const s = sources({
      connections: [...ALL_FRESH.filter((c) => c.provider !== "SHOPIFY"), { provider: "SHOPIFY", status: "ACTIVE", lastSyncedAt: STALE }],
      netRevenue: { valueMinor: "0" },
      sales: { status: "ESTIMATED", grossSales: { valueMinor: "0" }, orders: { value: 0 } },
    });
    for (const k of ["net_revenue_day", "gross_sales_day", "order_count_day", "cm3_pct_28d", "inventory_value"]) {
      expect(keys(s), k).not.toContain(k);
    }
    expect(why(s, "net_revenue_day")).toMatch(/never observed this day.*SHOPIFY last synced/);
    // Sources on a different feed are unaffected — this is per-metric, not
    // all-or-nothing.
    expect(keys(s)).toContain("available_cash");
    expect(keys(s)).toContain("rto_rate_28d");
  });

  it("treats a never-synced connection as never having observed anything", () => {
    const s = sources({
      connections: [{ provider: "BANK", status: "ACTIVE", lastSyncedAt: null }],
    });
    expect(keys(s)).not.toContain("available_cash");
    expect(why(s, "available_cash")).toMatch(/never/);
  });

  it("requires ALL sources of a kind, not just one, to have seen the day", () => {
    // A store shipping through two couriers with one feed stopped has an RTO
    // rate built from half its parcels — a different measurement wearing the
    // same name, and unlike a stale card this row is never revisited.
    const s = sources({
      connections: [
        ...ALL_FRESH,
        { provider: "BLUEDART", status: "ACTIVE", lastSyncedAt: STALE },
      ],
    });
    expect(keys(s)).not.toContain("rto_rate_28d");
    expect(why(s, "rto_rate_28d")).toMatch(/BLUEDART/);
  });

  it("ignores connections that are not ACTIVE", () => {
    // A PENDING or REVOKED connection is not a stale source, it is not a
    // source — letting it count would block a metric forever on the strength
    // of a half-finished connect flow.
    const s = sources({
      connections: [...ALL_FRESH, { provider: "AMAZON", status: "PENDING", lastSyncedAt: null }],
    });
    expect(keys(s)).toContain("net_revenue_day");
  });

  it("treats a sync exactly at the day boundary as not having covered it", () => {
    // Synced at the last millisecond of the day: everything after that instant
    // is unseen, and "the whole day" includes that instant.
    const atBoundary = sources({
      connections: [{ provider: "BANK", status: "ACTIVE", lastSyncedAt: DAY_END }],
    });
    expect(observedThroughDay(atBoundary.connections, DAILY_SNAPSHOT_METRICS[0]!.sources, DAY_END).observed).toBe(false);
    const justAfter = sources({
      connections: [{ provider: "BANK", status: "ACTIVE", lastSyncedAt: new Date(DAY_END.getTime() + 1) }],
    });
    expect(observedThroughDay(justAfter.connections, DAILY_SNAPSHOT_METRICS[0]!.sources, DAY_END).observed).toBe(true);
  });
});

describe("an observed day with no number is omitted too, with its own reason", () => {
  it("drops ad spend when no account-day reached us, and when the total is null", () => {
    expect(keys(sources({ adSpend: { valueMinor: "0", dayCount: 0 } }))).not.toContain("ad_spend_day");
    expect(why(sources({ adSpend: { valueMinor: "0", dayCount: 0 } }), "ad_spend_day")).toMatch(/no ad-spend records/);
    // Mixed currency nulls the total in ads.ts rather than summing USD into INR.
    expect(why(sources({ adSpend: { valueMinor: null, dayCount: 3 } }), "ad_spend_day")).toMatch(/currency/);
  });

  it("drops the RTO rate when nothing was dispatched", () => {
    // A rate over zero dispatches is undefined, not 0%.
    const s = sources({ rto: { rtoRatePct: null, dispatchedCount: 0 } });
    expect(keys(s)).not.toContain("rto_rate_28d");
    expect(why(s, "rto_rate_28d")).toMatch(/nothing was dispatched/);
  });

  it("drops inventory when no catalogue is synced", () => {
    expect(keys(sources({ inventory: { valueMinor: "0", variantCount: 0 } }))).not.toContain("inventory_value");
  });

  it("drops payables when there are no bills, or when the book spans currencies", () => {
    expect(keys(sources({ payables: { connected: false, totalOutstandingMinor: "0" } }))).not.toContain(
      "payables_outstanding"
    );
    expect(keys(sources({ payables: { connected: true, totalOutstandingMinor: null } }))).not.toContain(
      "payables_outstanding"
    );
  });

  it("drops both COD buckets when there is no courier data", () => {
    const s = sources({ cod: { hasCourierData: false, deliveredValue: 0n, unknownValue: 0n } });
    expect(keys(s)).not.toContain("cod_delivered_value");
    // Recording ₹0 gone dark for a store with no tracking would read as
    // reassurance about something nobody measured.
    expect(keys(s)).not.toContain("cod_unknown_value");
  });

  it("drops runway when §85's precondition fails, and carries burn.ts's own reason", () => {
    const s = sources({ burn: { runwayMonths: null, runwayReason: "Net cash inflow over the observed period." } });
    expect(keys(s)).not.toContain("runway_months");
    expect(why(s, "runway_months")).toBe("Net cash inflow over the observed period.");
  });

  it("drops CM3 when there is no net revenue to divide by", () => {
    expect(keys(sources({ contribution: { levels: { cm3: { marginPct: null } } } }))).not.toContain("cm3_pct_28d");
  });
});

describe("a measured zero IS recorded", () => {
  it("writes a quiet day as zero when every source was up to date through it", () => {
    // The distinction the whole module turns on. Same ₹0 as the stopped-sync
    // case above, opposite meaning: here the feeds were current through the
    // day, so the store genuinely took no orders. Omitting it would put a hole
    // in the series indistinguishable from a night the job did not run.
    const s = sources({
      cashReceived: { valueMinor: "0" },
      netRevenue: { valueMinor: "0" },
      sales: { status: "ESTIMATED", grossSales: { valueMinor: "0" }, orders: { value: 0 } },
    });
    expect(row(s, "cash_received_day")!.valueMinor).toBe(0n);
    expect(row(s, "net_revenue_day")!.valueMinor).toBe(0n);
    expect(row(s, "order_count_day")!.valueNumeric).toBe(0);
  });
});

describe("confidence is the calc layer's own verdict, not a second opinion", () => {
  it("marks sales-derived rows ESTIMATED when the window is not fully covered", () => {
    const s = sources({
      sales: { status: "INCOMPLETE", grossSales: { valueMinor: "900000" }, orders: { value: 42 } },
    });
    expect(row(s, "net_revenue_day")!.confidence).toBe("ESTIMATED");
    expect(row(s, "gross_sales_day")!.confidence).toBe("ESTIMATED");
  });

  it("downgrades a balance missing an opening anchor", () => {
    const s = sources({
      availableCash: {
        valueMinor: "5000000",
        connections: [{ connectionId: "c1", label: "HDFC", balanceMinor: "5000000", balance: 50000 }],
        missingOpeningBalance: [{ connectionId: "c2", label: "ICICI" }],
      },
    });
    expect(row(s, "available_cash")!.confidence).toBe("ESTIMATED");
  });

  it("never claims RECONCILED or FINAL", () => {
    // §42.8: nothing here has been matched against a statement, so no row this
    // module writes may ever claim reconciliation.
    for (const r of decideDailyRows(sources()).rows) {
      expect(["ESTIMATED", "PROVISIONAL"]).toContain(r.confidence);
    }
    expect(row(sources(), "available_cash")!.confidence).toBe("PROVISIONAL");
  });
});

describe("lastCompleteDay", () => {
  it("is yesterday on the organisation's calendar, not UTC's", () => {
    // 00:30 IST on 13 Aug is still 12 Aug in UTC. Targeting UTC's yesterday
    // would write a row for the 11th — a day already recorded — and skip the
    // 12th entirely.
    const justAfterMidnightIst = new Date("2026-08-12T19:00:00.000Z"); // 00:30 IST, 13 Aug
    expect(lastCompleteDay(justAfterMidnightIst, "Asia/Kolkata")).toBe("2026-08-12");
    expect(lastCompleteDay(justAfterMidnightIst, "UTC")).toBe("2026-08-11");
  });

  it("advances by exactly one day per 24 hours, in every timezone", () => {
    // What makes one cron safe for organisations on different calendars: a
    // fixed instant fires once per UTC day, so each org's target advances by
    // one. A day captured twice would overwrite a closed row; a day skipped
    // could never be recovered, because the position metrics read
    // current-state tables with no history behind them.
    for (const tz of ["Asia/Kolkata", "UTC", "America/New_York", "Australia/Sydney"]) {
      const seen: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        seen.push(lastCompleteDay(new Date(Date.UTC(2026, 7, 10 + i, 20, 35)), tz));
      }
      const unique = new Set(seen);
      expect(unique.size, `${tz} repeated a day`).toBe(seen.length);
      for (let i = 1; i < seen.length; i += 1) {
        const gap = (Date.parse(`${seen[i]}T00:00:00Z`) - Date.parse(`${seen[i - 1]}T00:00:00Z`)) / 86_400_000;
        expect(gap, `${tz} jumped ${gap} days`).toBe(1);
      }
    }
  });
});
