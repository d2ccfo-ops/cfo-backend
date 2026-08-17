import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";

// THE ONLY SOURCE OF BILLED TRUTH, IF SOMEBODY TURNS IT ON.
//
// cloudCost.ts prices the inventory that exists against Google's published
// rates, and is careful to call itself a floor. It cannot see egress, Cloud
// Build minutes, Artifact Registry storage, sustained-use discounts, committed
// use, credits, support or tax. The gap between that floor and the invoice is
// unbounded and unknowable from inside the VM.
//
// Google's Cloud Billing export to BigQuery closes it. It is the actual billed
// line items, per SKU, per day, and it is what the invoice is computed from.
//
// IT CANNOT BE ENABLED FROM HERE, and that is not an oversight to work around.
// There is no API to configure a billing export — it is a Cloud Console setting
// on the billing account, deliberately, because it writes billing data into a
// dataset and Google requires a human with billing-admin to choose where. So
// this module does the only honest thing available: it reads the export if one
// exists, and if one does not, it says exactly that and exactly what to click,
// rather than rendering an empty chart that reads as "we spent nothing".
//
// THE STATES ARE KEPT APART ON PURPOSE. "No export configured", "configured but
// this service account cannot read it", and "configured, readable, and the
// month is genuinely zero" are three completely different situations that a
// single null would merge into one shrug.

const BQ = "https://bigquery.googleapis.com/bigquery/v2";
const METADATA = "http://metadata.google.internal/computeMetadata/v1";

export type BillingState =
  | "not_configured"
  | "no_dataset"
  | "no_export_table"
  | "unauthorised"
  | "unavailable"
  | "ok";

export interface BillingMonth {
  month: string;
  /** Microdollars, bigint-as-string. Net of credits, which is what is invoiced. */
  costUsdMicro: string;
  creditsUsdMicro: string;
  /** Before credits, so a discount is visible rather than baked in. */
  grossUsdMicro: string;
}

export interface BillingSku {
  sku: string;
  service: string;
  costUsdMicro: string;
}

export interface BillingExport {
  state: BillingState;
  /** Present only when state is "ok". */
  months: BillingMonth[];
  topSkus: BillingSku[];
  project: string | null;
  dataset: string | null;
  table: string | null;
  /** Human sentence. Always set when state is not "ok". */
  message: string | null;
  /** The exact steps, when the fix is a Console setting nobody can automate. */
  howToEnable: string[] | null;
  readAt: string;
}

async function metadata(path: string): Promise<string | null> {
  try {
    const res = await fetch(`${METADATA}/${path}`, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? (await res.text()).trim() : null;
  } catch {
    // Not on GCE. Expected on a laptop, and not an error worth logging every
    // time the panel is opened.
    return null;
  }
}

async function accessToken(): Promise<string | null> {
  const raw = await metadata("instance/service-accounts/default/token");
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as { access_token?: string }).access_token ?? null;
  } catch {
    return null;
  }
}

const ENABLE_STEPS = [
  "Cloud Console → Billing → your billing account → Billing export → BigQuery export.",
  "Under “Detailed usage cost”, click Edit settings.",
  "Pick (or create) a dataset in this project — a region close to the VM, e.g. asia-south1.",
  "Save. Google starts writing within a few hours; it does NOT backfill, so history begins the day it is enabled.",
  "Set GCP_BILLING_BQ_DATASET to that dataset id in the deployment .env, then restart the API.",
];

/**
 * Read the billing export.
 *
 * Never throws. Every failure resolves to a state and a sentence, because this
 * is rendered on a page and a panel that 500s teaches nothing.
 */
export async function readBillingExport(months = 6): Promise<BillingExport> {
  const readAt = new Date().toISOString();
  const base: BillingExport = {
    state: "not_configured",
    months: [],
    topSkus: [],
    project: null,
    dataset: env.GCP_BILLING_BQ_DATASET ?? null,
    table: null,
    message: null,
    howToEnable: null,
    readAt,
  };

  if (!env.GCP_BILLING_BQ_DATASET) {
    return {
      ...base,
      state: "not_configured",
      message:
        "No billing export is configured, so nothing here is invoiced truth — the cloud figure elsewhere on this page is a priced floor over the inventory that exists.",
      howToEnable: ENABLE_STEPS,
    };
  }

  const [project, token] = await Promise.all([metadata("project/project-id"), accessToken()]);
  if (!project || !token) {
    return {
      ...base,
      state: "unavailable",
      message:
        "The GCE metadata service did not answer, so there is no credential to query BigQuery with. Expected off the VM; on the VM it means the instance has no default service account.",
    };
  }

  const auth = { Authorization: `Bearer ${token}` };
  const dataset = env.GCP_BILLING_BQ_DATASET;

  // The export table's name embeds the billing account id, which this process
  // has no way to know. So it is discovered rather than constructed — and a
  // dataset holding no such table is a distinct, nameable state.
  let table: string | null = null;
  try {
    const res = await fetch(`${BQ}/projects/${project}/datasets/${dataset}/tables?maxResults=200`, {
      headers: auth,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) {
      return { ...base, project, state: "no_dataset", message: `Dataset “${dataset}” does not exist in project ${project}.`, howToEnable: ENABLE_STEPS };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ...base,
        project,
        state: "unauthorised",
        message: `The VM's service account cannot read dataset “${dataset}”. Grant it roles/bigquery.dataViewer and roles/bigquery.jobUser on ${project}.`,
      };
    }
    if (!res.ok) {
      return { ...base, project, state: "unavailable", message: `BigQuery answered ${res.status} listing tables in “${dataset}”.` };
    }
    const body = (await res.json()) as { tables?: Array<{ tableReference?: { tableId?: string } }> };
    // Prefer the detailed (resource-level) export: it carries per-resource
    // labels, which is what makes per-tenant attribution possible later.
    const ids = (body.tables ?? []).map((t) => t.tableReference?.tableId ?? "").filter(Boolean);
    table =
      ids.find((id) => id.startsWith("gcp_billing_export_resource_v1_")) ??
      ids.find((id) => id.startsWith("gcp_billing_export_v1_")) ??
      null;
    if (!table) {
      return {
        ...base,
        project,
        state: "no_export_table",
        message: `Dataset “${dataset}” exists but holds no gcp_billing_export table. The export was probably pointed at a different dataset.`,
        howToEnable: ENABLE_STEPS,
      };
    }
  } catch (err) {
    return { ...base, project, state: "unavailable", message: err instanceof Error ? err.message : String(err) };
  }

  // Two queries in one job would need a script; two jobs is simpler and the
  // rows are tiny. Both are parameterised — the only interpolated values are
  // the project and table ids already validated above.
  const fq = `\`${project}.${dataset}.${table}\``;
  const monthsSql = `
    SELECT FORMAT_TIMESTAMP('%Y-%m', usage_start_time) AS month,
           SUM(cost) AS gross,
           SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS credits
      FROM ${fq}
     WHERE usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
     GROUP BY month
     ORDER BY month`;
  const skuSql = `
    SELECT sku.description AS sku, service.description AS service, SUM(cost) AS cost
      FROM ${fq}
     WHERE usage_start_time >= TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), MONTH)
     GROUP BY sku, service
     ORDER BY cost DESC
     LIMIT 15`;

  const projectId = project;
  async function query(sql: string, days?: number): Promise<Array<Record<string, string | null>>> {
    const res = await fetch(`${BQ}/projects/${projectId}/queries`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: sql,
        useLegacySql: false,
        timeoutMs: 20_000,
        ...(days === undefined
          ? {}
          : { queryParameters: [{ name: "days", parameterType: { type: "INT64" }, parameterValue: { value: String(days) } }] }),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`BigQuery query failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as {
      schema?: { fields?: Array<{ name: string }> };
      rows?: Array<{ f?: Array<{ v: string | null }> }>;
    };
    const fields = (body.schema?.fields ?? []).map((f) => f.name);
    return (body.rows ?? []).map((r) => {
      const o: Record<string, string | null> = {};
      fields.forEach((name, i) => {
        o[name] = r.f?.[i]?.v ?? null;
      });
      return o;
    });
  }

  try {
    const [monthRows, skuRows] = await Promise.all([query(monthsSql, months * 31), query(skuSql)]);
    const micro = (v: string | null) => BigInt(Math.round(Number(v ?? 0) * 1_000_000)).toString();
    return {
      ...base,
      project,
      table,
      state: "ok",
      months: monthRows.map((r) => {
        const gross = Number(r.gross ?? 0);
        const credits = Number(r.credits ?? 0);
        return {
          month: r.month ?? "",
          grossUsdMicro: micro(String(gross)),
          creditsUsdMicro: micro(String(credits)),
          // Credits arrive NEGATIVE in the export, so this is a sum, not a
          // subtraction. Writing it as gross - credits inverts every discount.
          costUsdMicro: micro(String(gross + credits)),
        };
      }),
      topSkus: skuRows.map((r) => ({ sku: r.sku ?? "unknown", service: r.service ?? "unknown", costUsdMicro: micro(r.cost ?? null) })),
      message: null,
    };
  } catch (err) {
    logger.warn({ err }, "billing_export_query_failed");
    return { ...base, project, table, state: "unavailable", message: err instanceof Error ? err.message : String(err) };
  }
}
