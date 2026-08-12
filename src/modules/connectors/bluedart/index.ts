import crypto from "node:crypto";
import type { ShipmentStatus } from "@prisma/client";
import { XMLParser } from "fast-xml-parser";
import { decryptSecret } from "../../../lib/crypto.js";
import { zonedTimeToUtc } from "../../../lib/dateRange.js";
import { prisma } from "../../../lib/prisma.js";
import { ingestStatement, type IngestResult, type StatementFormat } from "../remittance/statement.js";
import type { Connector, ConnectorContext, SyncResult, WebhookVerificationResult } from "../types.js";

// Bluedart. Two data paths, because Bluedart genuinely has two:
//
//   1. TRACKING — a real HTTP API. Auth is a JWT obtained from the API gateway
//      using a ClientID/clientSecret pair issued per licence; tracking then
//      accepts a batch of waybill numbers. Like Delhivery, there is NO "list my
//      shipments" endpoint, so this can only re-track AWBs already known from
//      the order/courier side. backfill() is therefore a real no-op, not an
//      unimplemented stub.
//
//   2. COD REMITTANCE — NOT an API. Bluedart distributes COD remittance as an
//      MIS report (emailed or dropped on SFTP), which is why this connector's
//      remittance path is a statement import rather than a poll. Building an
//      API client for a document that arrives as a spreadsheet would be
//      building the wrong thing, and it is the same reason the bank connector
//      is an upload.
//
// VERIFIED against DHL's published Blue Dart API reference (Blue Dart is part of
// DHL eCommerce India, and DHL's developer portal is the authoritative spec):
// https://developer.dhl.com/api-reference/blue-dart-tracking-shipment
//
// Three things that reference corrected, each of which would have broken every
// live call:
//
//   - The endpoint is the versioned base ITSELF with query params hung off it
//     (`/tracking/v1?handler=tnt&...`). There is no `/shipment` resource
//     segment; adding one 404s.
//   - `format` MUST be `xml`. Blue Dart's tracking API does not emit JSON at
//     all, so the previous `format=json` + `res.json()` pair would have thrown
//     on the very first response.
//   - `awb` is a REQUIRED parameter and is not the waybill number — it is the
//     lookup MODE. `awb=awb` means "the values in `numbers` are waybill
//     numbers"; `awb=ref` means they are the shipper's own reference numbers.
//     `numbers` carries the actual identifiers.
//
// Still unverified (no live licensed account): the exact XML element names and
// the scan vocabulary. Those are read defensively — attributes and child
// elements are merged into one namespace so either shape resolves, unknown
// statuses fall through to UNKNOWN rather than to a plausible neighbour, and
// the full payload is always stored.
//
// The remittance path carries none of that uncertainty: it is a CSV whose
// columns this repo defines. Blue Dart distributes COD remittance as an MIS
// report (emailed or dropped on SFTP), never as an API — which is why that path
// is an import rather than a poll.

const GATEWAY_BASE = "https://apigateway.bluedart.com/in/transportation";
const TOKEN_PATH = "/token/v1/login";
const TRACKING_PATH = "/tracking/v1";
// Blue Dart's tracking gateway takes `numbers` as a comma-separated list.
const MAX_AWBS_PER_REQUEST = 25;
const BLUEDART_SCAN_TIMEZONE = "Asia/Kolkata";

// The ClientID/clientSecret pair is OPTIONAL, and discovering that unblocked a
// real merchant who had been issued only the other two.
//
// Probed against the live gateway: `token/v1/login` mints a valid JWT to a
// caller sending NO credential headers at all, and returns 401 only when the
// headers are present and wrong. So the ClientID pair is not needed to reach
// tracking, and demanding it blocked a merchant who had only the other two.
//
// An earlier version of this comment claimed more than that — it said a wrong
// licence key comes back `License Mismatch`, proving the licence authorises the
// account. That was measured wrong. A deliberately invalid licence key returns
// `Incorrect waybill number or No information`, byte-identical to a valid one.
// Nothing this endpoint returns distinguishes a good credential from a bad one,
// so no claim is made about which value authorises what.
//
// Both are still stored when supplied: an app-authenticated token is the
// documented path, may be rate-limited more generously, and the anonymous
// route is an observed behaviour rather than a promised one — so if Bluedart
// closes it, a connection holding all four keeps working untouched.
// Bluedart issues TWO licence keys, and its own onboarding sheet lists them as
// separate fields: `license_key` for the shipping/waybill APIs, and
// `tracking_license_key` for tracking. They are different 32-char values. This
// connector spent a long time sending the shipping key to the tracking endpoint
// because only one key had been supplied.
//
// Sending the right one does NOT currently change the response — measured, both
// keys return the identical "Incorrect waybill number or No information", as
// does a deliberately invalid key — but the tracking path uses the tracking key
// when present so that the day Bluedart enables it, nothing else has to change.
export interface BluedartCredentials {
  clientId?: string;
  clientSecret?: string;
  licenceKey: string;
  /** `tracking_license_key` from Bluedart's onboarding sheet. Falls back to `licenceKey`. */
  trackingLicenceKey?: string;
  loginId: string;
}

export function trackingLicenceKey(creds: BluedartCredentials): string {
  return creds.trackingLicenceKey || creds.licenceKey;
}

export function encodeCredentials(creds: BluedartCredentials): string {
  return JSON.stringify(creds);
}

function decodeCredentials(credentialsRef: string): BluedartCredentials {
  return JSON.parse(decryptSecret(credentialsRef)) as BluedartCredentials;
}

// Bluedart's own scan descriptions. Anything not listed maps to UNKNOWN rather
// than to a plausible neighbour — a shipment wrongly marked DELIVERED enters
// the COD-owed calculation as cash that should have arrived.
const STATUS_MAP: Record<string, ShipmentStatus> = {
  SHIPMENT_BOOKED: "NEW",
  "SHIPMENT BOOKED": "NEW",
  MANIFESTED: "NEW",
  PICKUP: "PICKED_UP",
  "PICKED UP": "PICKED_UP",
  "SHIPMENT PICKED UP": "PICKED_UP",
  "IN TRANSIT": "IN_TRANSIT",
  INTRANSIT: "IN_TRANSIT",
  "SHIPMENT ARRIVED": "IN_TRANSIT",
  "OUT FOR DELIVERY": "OUT_FOR_DELIVERY",
  DELIVERED: "DELIVERED",
  "SHIPMENT DELIVERED": "DELIVERED",
  UNDELIVERED: "RTO_INITIATED",
  "RTO INITIATED": "RTO_INITIATED",
  "RETURN TO ORIGIN": "RTO_INITIATED",
  "RTO DELIVERED": "RTO_DELIVERED",
  "RETURNED TO SHIPPER": "RTO_DELIVERED",
  CANCELLED: "CANCELLED",
  LOST: "LOST",
};

function mapStatus(raw: string | null | undefined): ShipmentStatus {
  if (!raw) return "UNKNOWN";
  return STATUS_MAP[raw.trim().toUpperCase()] ?? "UNKNOWN";
}

interface BluedartScan {
  Scan?: string;
  ScanCode?: string;
  ScanDate?: string;
  ScanTime?: string;
  ScanType?: string;
  ScannedLocation?: string;
}

interface BluedartShipment {
  WaybillNo?: string;
  RefNo?: string;
  Status?: string;
  StatusDate?: string;
  StatusType?: string;
  PickUpDate?: string;
  CODAmount?: string | number;
  Scans?: { ScanDetail?: BluedartScan[] };
}

interface BluedartTrackResponse {
  ShipmentData?: { Shipment?: BluedartShipment | BluedartShipment[] };
}

// Blue Dart's tracking XML puts some values in attributes and some in child
// elements, and which is which is not documented. Merging both into one key
// namespace (no attribute prefix) means `WaybillNo` resolves whether it arrives
// as `<Shipment WaybillNo="...">` or `<Shipment><WaybillNo>...</WaybillNo>`.
//
// Values stay as strings: `parseTagValue` would turn a waybill number into a
// float and silently destroy its leading zeros and precision.
const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

// An XML document with exactly one <Shipment> parses to an object, not a
// one-element array. Every consumer here wants a list.
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export async function fetchToken(creds: BluedartCredentials): Promise<string> {
  // Headers are sent only when BOTH are present. Sending one, or sending an
  // empty string, is what turns a working anonymous request into a 401 — the
  // gateway rejects credentials it can see and cannot verify, and ignores
  // credentials that are absent.
  const authed = Boolean(creds.clientId && creds.clientSecret);
  const res = await fetch(`${GATEWAY_BASE}${TOKEN_PATH}`, {
    method: "GET",
    headers: {
      ...(authed ? { ClientID: creds.clientId!, clientSecret: creds.clientSecret! } : {}),
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(
      authed
        ? `bluedart token request failed: ${res.status} — check the ClientID and client secret`
        : `bluedart token request failed: ${res.status} — no ClientID was supplied and the gateway refused an anonymous token`
    );
  }
  const body = (await res.json()) as { JWTToken?: string };
  if (!body.JWTToken) throw new Error("bluedart token response carried no JWTToken");
  return body.JWTToken;
}

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

// Blue Dart scan stamps are NOT ISO. They arrive as "12-Jul-2026" or
// "12-07-2026", and the previous `new Date("12-Jul-2026T11:05:00")` produced
// Invalid Date for every single scan — which then fell through to `new Date()`
// and recorded the moment of the sync as the moment of delivery. A fabricated
// delivery timestamp is worse than none: COD ageing is computed off it, so
// every parcel would look freshly delivered forever.
//
// Times are Indian Standard Time. Blue Dart is a domestic Indian carrier and
// stamps scans in local time with no offset, so interpreting them in the
// server's zone would shift every delivery by the deployment's offset.
function parseScanTimestamp(date: string | undefined, time: string | undefined): Date | null {
  if (!date) return null;
  const parts = date.trim().split(/[-/\s]+/);
  if (parts.length < 3) return null;

  let [a, b, c] = parts as [string, string, string];
  let y: number, m: number, d: number;
  if (a.length === 4) {
    // "2026-07-12"
    y = Number(a); m = MONTHS[b.toUpperCase()] ?? Number(b); d = Number(c);
  } else {
    // "12-Jul-2026" or "12-07-2026"
    d = Number(a); m = MONTHS[b.toUpperCase()] ?? Number(b); y = Number(c);
  }
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  if (y < 100) y += 2000;

  const [hh = 0, mm = 0, ss = 0] = (time ?? "").trim().split(":").map(Number);
  if (![hh, mm, ss].every(Number.isFinite)) return null;

  return zonedTimeToUtc(y, m, d, hh, mm, ss, 0, BLUEDART_SCAN_TIMEZONE);
}

function parseScanDate(shipment: BluedartShipment, wanted: ShipmentStatus): Date | null {
  const scans = asArray(shipment.Scans?.ScanDetail);
  // Latest matching scan wins: a parcel can be scanned "out for delivery" twice,
  // and the reattempt is the one that reflects reality.
  let found: Date | null = null;
  for (const s of scans) {
    if (mapStatus(s.Scan) !== wanted) continue;
    const d = parseScanTimestamp(s.ScanDate, s.ScanTime);
    if (d && (!found || d > found)) found = d;
  }
  return found;
}

async function trackAwbs(ctx: ConnectorContext, awbs: string[]): Promise<number> {
  if (awbs.length === 0) return 0;
  const creds = decodeCredentials(ctx.credentialsRef);
  const token = await fetchToken(creds);
  let updated = 0;

  for (let i = 0; i < awbs.length; i += MAX_AWBS_PER_REQUEST) {
    const batch = awbs.slice(i, i + MAX_AWBS_PER_REQUEST);
    const url = new URL(`${GATEWAY_BASE}${TRACKING_PATH}`);
    url.searchParams.set("handler", "tnt");
    url.searchParams.set("action", "custawbquery");
    url.searchParams.set("loginid", creds.loginId);
    // Lookup MODE, not a value: "awb" declares that `numbers` holds waybill
    // numbers rather than shipper reference numbers.
    url.searchParams.set("awb", "awb");
    url.searchParams.set("numbers", batch.join(","));
    url.searchParams.set("format", "xml");
    // The TRACKING key, not the shipping one — Bluedart issues both.
    url.searchParams.set("lickey", trackingLicenceKey(creds));
    // `verno` is deliberately NOT sent. It appears in Bluedart's published
    // examples, but probed against the live gateway with a real licence key it
    // turns every response into `<Error>License Mismatch</Error>` — including
    // for waybills Bluedart's own public tracker resolves with full scan
    // history. Omitting it gets past the licence check; the gateway falls back
    // to its default version. Sending a documented parameter that provably
    // breaks every request would make a valid licence look invalid.
    // scan=1 returns the full scan history; without it only the latest status
    // comes back, and the delivery timestamp cannot be recovered.
    url.searchParams.set("scan", "1");

    const res = await fetch(url, { headers: { JWTToken: token, Accept: "application/xml" } });
    if (!res.ok) throw new Error(`bluedart tracking failed: ${res.status}`);
    const body = xml.parse(await res.text()) as BluedartTrackResponse;

    for (const shipment of asArray(body.ShipmentData?.Shipment)) {
      const awb = shipment.WaybillNo?.trim();
      if (!awb) continue;
      const status = mapStatus(shipment.Status);
      // No `?? new Date()`. If the scan carries no parsable timestamp we record
      // the status and leave the date unset — an absent delivery date is a
      // visible gap, an invented one silently corrupts COD ageing.
      const deliveredAt = status === "DELIVERED" ? parseScanDate(shipment, "DELIVERED") : null;
      const pickedUpAt = parseScanDate(shipment, "PICKED_UP");

      await prisma.shipment.updateMany({
        where: { connectionId: ctx.connectionId, awbCode: awb },
        data: {
          status,
          // Only ever written, never cleared — a later scan that omits the
          // pickup timestamp must not erase one we already have.
          ...(pickedUpAt ? { pickedUpAt } : {}),
          ...(deliveredAt ? { deliveredAt } : {}),
          raw: shipment as object,
        },
      });
      updated += 1;
    }
  }
  return updated;
}

// The COD remittance MIS. Column spellings accept the variants Bluedart's own
// reports use across versions — renaming a column between report versions is far
// more common than changing what it means.
export const BLUEDART_COD_STATEMENT: StatementFormat = {
  provider: "BLUEDART",
  lineType: "SHIPMENT_COD",
  kind: "COD_REMITTANCE",
  label: "Bluedart COD remittance MIS",
  columns: {
    batchId: ["Remittance No", "RemittanceNo", "Payout Reference", "Settlement Id", "Batch Id"],
    utr: ["UTR", "UTR No", "Bank Reference", "NEFT Ref"],
    paidOn: ["Remittance Date", "Payout Date", "Credit Date", "Paid On"],
    reference: ["Waybill No", "WaybillNo", "AWB", "AWB No", "Airway Bill"],
    gross: ["COD Amount", "CODAmount", "Collected Amount", "Gross Amount"],
    fee: ["COD Charges", "Deduction", "Service Charge", "Fee"],
    net: ["Net Amount", "NetAmount", "Remitted Amount"],
    batchTotal: ["Total Remittance", "Batch Total", "Payout Amount"],
  },
};

export async function ingestCodRemittance(ctx: ConnectorContext, csv: string): Promise<IngestResult> {
  return ingestStatement(
    { connectionId: ctx.connectionId, organizationId: ctx.organizationId, legalEntityId: ctx.legalEntityId },
    csv,
    BLUEDART_COD_STATEMENT
  );
}

export const bluedartConnector: Connector = {
  provider: "BLUEDART",

  // Nothing to pull on first connect — Bluedart's API tracks waybills you
  // already know and cannot enumerate them. Shipments reach us from the order
  // side; this connector enriches them.
  async backfill(): Promise<SyncResult> {
    return { recordsFetched: 0, cursor: null };
  },

  // Re-track shipments that are still moving. Terminal ones are excluded —
  // re-asking about a parcel delivered three months ago spends the rate limit
  // on an answer that cannot change.
  async sync(ctx: ConnectorContext): Promise<SyncResult> {
    const open = await prisma.shipment.findMany({
      where: {
        connectionId: ctx.connectionId,
        awbCode: { not: null },
        status: { notIn: ["DELIVERED", "RTO_DELIVERED", "CANCELLED", "LOST"] },
      },
      select: { awbCode: true },
      take: 500,
    });
    const awbs = open.map((s) => s.awbCode!).filter(Boolean);
    const updated = await trackAwbs(ctx, awbs);
    return { recordsFetched: updated, cursor: new Date().toISOString() };
  },

  // Bluedart's push-tracking posts to a URL you register with them and carries
  // no documented signature scheme — the same situation as Delhivery. The
  // shared secret therefore lives in the URL path, and this function only
  // derives an idempotency key.
  verifyWebhook(rawBody: Buffer): WebhookVerificationResult {
    const digest = crypto.createHash("sha256").update(rawBody).digest("hex");
    let eventType = "tracking.update";
    try {
      const parsed = JSON.parse(rawBody.toString("utf8")) as { Status?: string };
      if (parsed.Status) eventType = `tracking.${parsed.Status.toLowerCase().replace(/\s+/g, "_")}`;
    } catch {
      // A body we cannot parse is still stored as a RawEvent — §112 keeps the
      // raw layer independent of whether we understood it.
    }
    return { valid: true, externalEventId: digest, eventType };
  },

  async processEvent(ctx: ConnectorContext, payload: unknown): Promise<void> {
    const shipment = payload as BluedartShipment;
    const awb = shipment.WaybillNo?.trim();
    if (!awb) return;
    const status = mapStatus(shipment.Status);
    // Same rule as the polling path: never invent a delivery timestamp.
    const deliveredAt = status === "DELIVERED" ? parseScanDate(shipment, "DELIVERED") : null;
    const pickedUpAt = parseScanDate(shipment, "PICKED_UP");

    await prisma.shipment.updateMany({
      where: { connectionId: ctx.connectionId, awbCode: awb },
      data: {
        status,
        ...(pickedUpAt ? { pickedUpAt } : {}),
        ...(deliveredAt ? { deliveredAt } : {}),
        raw: shipment as object,
      },
    });
  },
};
