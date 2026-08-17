import { logger } from "../../lib/logger.js";

// WHAT GCP CHARGES US, built from the resources that actually exist priced
// against Google's own published SKUs.
//
// READ THIS BEFORE QUOTING THE NUMBER. This is a COST MODEL, not an invoice.
// The only source of billed truth is the Cloud Billing export to BigQuery, and
// this project has none configured — BigQuery is enabled but holds no dataset,
// and there is no public API to configure the export (it is a Console setting).
// So rather than render an empty page or, worse, invented rupees, this prices
// the real inventory:
//
//   * the instance's ACTUAL machine type, read from the Compute API — not a
//     constant, so a resize is reflected without anyone editing code
//   * every attached disk, at its actual size and type
//   * the reserved static address
//
// against live rates from the Cloud Billing Catalog. Both halves are real; what
// is missing is everything usage-based:
//
//   * network egress — the single most likely gap, and unmeasurable here
//   * Cloud Build minutes, Artifact Registry storage
//   * support, taxes, credits, committed-use discounts, sustained-use discounts
//
// So the figure is a FLOOR on the compute bill, and is labelled that way all
// the way to the screen. It will not match the invoice and must never be
// presented as if it does.
//
// Authentication is the VM's own metadata service account (cloud-platform
// scope). Nothing is stored in .env and no key file exists.

const METADATA = "http://metadata.google.internal/computeMetadata/v1";
const COMPUTE_SKU_SERVICE = "6F81-5844-456A"; // Compute Engine, per Google's service list
const HOURS_PER_MONTH = 730;

export interface CostLine {
  label: string;
  detail: string;
  /** USD per hour for this line, or null when no SKU matched. */
  usdPerHour: number | null;
  usdPerMonth: number | null;
  /** How the price was found, so an unexpected figure can be traced. */
  sku: string | null;
}

export interface CloudCost {
  project: string | null;
  zone: string | null;
  machineType: string | null;
  lines: CostLine[];
  totalUsdPerMonth: number | null;
  /** Everything this model cannot see. Rendered next to the total, never omitted. */
  excludes: string[];
  isInvoice: false;
  computedAt: string;
  error?: string;
}

async function metadata(path: string): Promise<string | null> {
  try {
    const res = await fetch(`${METADATA}/${path}`, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? await res.text() : null;
  } catch {
    // Not on GCE (a laptop, CI). Not an error — the caller reports it as
    // "unavailable here" rather than pretending to a cost of zero.
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

interface Sku {
  description: string;
  usd: number;
  unit: string;
}

/**
 * The Compute Engine price list for one region.
 *
 * Cached for an hour: it is thousands of paginated SKUs, it changes about as
 * often as Google announces a price change, and fetching it per request would
 * make an observability page the most expensive thing on the box.
 */
let skuCache: { at: number; region: string; skus: Sku[] } | null = null;

/**
 * asia-south1 on-demand rates, verified against the live Cloud Billing catalog
 * on 2026-08-17.
 *
 * EMBEDDED RATHER THAN FETCHED, and that is a permissions decision. Reading the
 * catalog at runtime needs cloudbilling access on the VM's service account —
 * the production API returned `billing catalog 403` — and granting a
 * cross-tenant finance server the ability to read billing data to render a
 * cost estimate is a worse trade than keeping five numbers in the repo.
 *
 * Same shape as lib/aiPricing.ts and for the same reason: prices change on
 * announced dates, so they are dated, and history stays priced correctly.
 * Verify with:
 *   gcloud billing accounts list  # then the catalog API, see git history
 */
const MUMBAI_RATES = {
  verifiedOn: "2026-08-17",
  e2CustomCoreHour: 0.02750926,
  e2CustomRamGibHour: 0.003686256,
  balancedPdGibMonth: 0.12,
  standardPdGibMonth: 0.048,
  staticIpHour: 0.012,
} as const;

async function fetchSkus(token: string, region: string): Promise<Sku[]> {
  if (skuCache && skuCache.region === region && Date.now() - skuCache.at < 3_600_000) {
    return skuCache.skus;
  }
  const out: Sku[] = [];
  let url: string | null =
    `https://cloudbilling.googleapis.com/v1/services/${COMPUTE_SKU_SERVICE}/skus?pageSize=5000`;
  while (url) {
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`billing catalog ${res.status}`);
    const body = (await res.json()) as {
      skus?: Array<{
        description: string;
        serviceRegions?: string[];
        pricingInfo?: Array<{ pricingExpression?: { usageUnit?: string; tieredRates?: Array<{ unitPrice?: { units?: string; nanos?: number } }> } }>;
      }>;
      nextPageToken?: string;
    };
    for (const s of body.skus ?? []) {
      if (!(s.serviceRegions ?? []).includes(region)) continue;
      const pe = s.pricingInfo?.[0]?.pricingExpression;
      const rate = pe?.tieredRates?.[pe.tieredRates.length - 1]?.unitPrice;
      if (!rate) continue;
      const usd = Number(rate.units ?? 0) + (rate.nanos ?? 0) / 1e9;
      if (usd <= 0) continue;
      out.push({ description: s.description, usd, unit: pe?.usageUnit ?? "" });
    }
    url = body.nextPageToken
      ? `https://cloudbilling.googleapis.com/v1/services/${COMPUTE_SKU_SERVICE}/skus?pageSize=5000&pageToken=${body.nextPageToken}`
      : null;
  }
  skuCache = { at: Date.now(), region, skus: out };
  return out;
}

/**
 * Pick the on-demand SKU matching every term.
 *
 * Spot, preemptible and commitment SKUs are excluded explicitly. They are
 * cheaper and they are not what this instance is billed at, so matching one by
 * accident would understate the bill — the direction of error that gets
 * noticed last.
 */
function findSku(skus: Sku[], terms: string[]): Sku | null {
  const hits = skus.filter(
    (s) =>
      terms.every((t) => s.description.toLowerCase().includes(t.toLowerCase())) &&
      !/spot|preemptible|commitment|custom extended/i.test(s.description),
  );
  hits.sort((a, b) => a.description.length - b.description.length);
  return hits[0] ?? null;
}

export async function computeCloudCost(): Promise<CloudCost> {
  const computedAt = new Date().toISOString();
  const excludes = [
    "network egress",
    "Cloud Build minutes",
    "Artifact Registry storage",
    "support, taxes and credits",
    "sustained-use and committed-use discounts",
  ];
  const base: CloudCost = {
    project: null, zone: null, machineType: null, lines: [],
    totalUsdPerMonth: null, excludes, isInvoice: false, computedAt,
  };

  const token = await accessToken();
  if (!token) {
    return { ...base, error: "Not running on GCE, or the metadata service account is unavailable — no inventory to price." };
  }

  try {
    const [project, zonePath, machineTypePath, name] = await Promise.all([
      metadata("project/project-id"),
      metadata("instance/zone"),
      metadata("instance/machine-type"),
      metadata("instance/name"),
    ]);
    // Both arrive as full resource paths: projects/123/zones/asia-south1-a
    const zone = zonePath?.split("/").pop() ?? null;
    const machineType = machineTypePath?.split("/").pop() ?? null;
    // asia-south1-a -> asia-south1. SKUs are regional, not zonal.
    const region = zone ? zone.replace(/-[a-z]$/, "") : null;
    if (!region || !zone || !project || !name) throw new Error("metadata incomplete");

    // The catalog is a bonus, not a dependency. If the service account cannot
    // read billing (it cannot, in production), the embedded rates carry the
    // whole calculation and the inventory is still live.
    const [skus, instanceRes] = await Promise.all([
      fetchSkus(token, region).catch(() => [] as Sku[]),
      fetch(`https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/${name}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ]);
    const rateSource = skus.length > 0 ? "live catalog" : `embedded, verified ${MUMBAI_RATES.verifiedOn}`;
    if (!instanceRes.ok) throw new Error(`compute api ${instanceRes.status}`);
    const instance = (await instanceRes.json()) as {
      disks?: Array<{ source?: string; diskSizeGb?: string; boot?: boolean }>;
    };

    const lines: CostLine[] = [];

    // e2-custom-4-8192 -> 4 vCPU, 8192 MiB. Parsed rather than assumed, so a
    // resize shows up here without a code change.
    const custom = /^([a-z0-9]+)-custom-(\d+)-(\d+)$/.exec(machineType ?? "");
    if (custom?.[2] && custom[3]) {
      const vcpu = Number(custom[2]);
      const gib = Number(custom[3]) / 1024;
      const coreRate = findSku(skus, ["E2 Custom Instance Core"])?.usd ?? MUMBAI_RATES.e2CustomCoreHour;
      const ramRate = findSku(skus, ["E2 Custom Instance Ram"])?.usd ?? MUMBAI_RATES.e2CustomRamGibHour;
      lines.push({ label: "vCPU", detail: `${vcpu} x custom E2 core`, usdPerHour: coreRate * vcpu, usdPerMonth: coreRate * vcpu * HOURS_PER_MONTH, sku: rateSource });
      lines.push({ label: "Memory", detail: `${gib.toFixed(0)} GiB`, usdPerHour: ramRate * gib, usdPerMonth: ramRate * gib * HOURS_PER_MONTH, sku: rateSource });
    } else if (machineType) {
      lines.push({ label: "Instance", detail: machineType, usdPerHour: null, usdPerMonth: null, sku: null });
    }

    // Disks, at their real sizes. Priced per GiB-month, so no hourly figure.
    for (const d of instance.disks ?? []) {
      const sizeGb = Number(d.diskSizeGb ?? 0);
      if (!sizeGb) continue;
      const diskName = d.source?.split("/").pop() ?? "disk";
      const diskRes = await fetch(
        `https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/disks/${diskName}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const type = diskRes.ok
        ? ((await diskRes.json()) as { type?: string }).type?.split("/").pop() ?? "pd-standard"
        : "pd-standard";
      const terms = type.includes("balanced")
        ? ["Balanced PD Capacity"]
        : type.includes("ssd")
          ? ["SSD backed PD Capacity"]
          : ["Storage PD Capacity"];
      const rate =
        findSku(skus, terms)?.usd ??
        (type.includes("balanced") ? MUMBAI_RATES.balancedPdGibMonth : MUMBAI_RATES.standardPdGibMonth);
      lines.push({
        label: "Disk",
        detail: `${diskName} — ${sizeGb} GB ${type}`,
        usdPerHour: null,
        usdPerMonth: rate * sizeGb,
        sku: rateSource,
      });
    }

    // A reserved address is only billed while ATTACHED to a running instance
    // at standard rates; the charge people are surprised by is the idle one.
    const ipRate = findSku(skus, ["Static Ip Charge"])?.usd ?? MUMBAI_RATES.staticIpHour;
    lines.push({
      label: "Static IP",
      detail: "reserved, in use",
      usdPerHour: ipRate,
      usdPerMonth: ipRate * HOURS_PER_MONTH,
      sku: rateSource,
    });

    const total = lines.reduce((a, l) => a + (l.usdPerMonth ?? 0), 0);
    return { project, zone, machineType, lines, totalUsdPerMonth: total || null, excludes, isInvoice: false, computedAt };
  } catch (err) {
    logger.warn({ err }, "cloud_cost_failed");
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}
