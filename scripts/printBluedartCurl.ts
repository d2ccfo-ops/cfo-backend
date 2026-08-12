import { decryptSecret } from "../src/lib/crypto.js";
import { prisma } from "../src/lib/prisma.js";
import { fetchToken } from "../src/modules/connectors/bluedart/index.js";

// Prints a ready-to-paste curl for Bluedart tracking, and optionally runs it.
//
// Same reason as printGokwikCurl.ts: credentials are encrypted at rest, so
// there is no way to hand someone a literal curl without decrypting them first.
//
// The licence key is MASKED by default, so the output is safe to paste into a
// ticket or a chat. Pass --reveal to print the real key — do that in your own
// terminal, not anywhere it gets logged.
//
// Run with: npx tsx scripts/printBluedartCurl.ts
//   --reveal   print the real licence key instead of a mask
//   --run      execute the request here and show the response
//   --control  also run the invalid-credential control, which is the whole point

const GATEWAY = "https://apigateway.bluedart.com/in/transportation";
const REVEAL = process.argv.includes("--reveal");

function mask(secret: string): string {
  return REVEAL ? secret : `${secret.slice(0, 4)}${"·".repeat(Math.max(0, secret.length - 8))}${secret.slice(-4)}`;
}

async function main() {
  const conn = await prisma.connection.findFirst({
    where: { provider: "BLUEDART" },
    orderBy: { createdAt: "desc" },
    select: { id: true, externalAccountId: true, credentialsRef: true, organizationId: true, lastSyncedAt: true },
  });
  if (!conn?.credentialsRef) {
    console.log("no BLUEDART connection found — connect it on the Connections page first");
    process.exit(1);
  }
  const org = await prisma.organization.findUnique({
    where: { id: conn.organizationId },
    select: { name: true },
  });
  const c = JSON.parse(decryptSecret(conn.credentialsRef)) as {
    loginId: string;
    licenceKey: string;
    clientId?: string;
    clientSecret?: string;
  };

  // A waybill carrying freightAmount is one the parsed tax invoices billed for,
  // and the invoices are issued to NDA821166 — so this is the strongest possible
  // test case: a waybill Bluedart's own billing says belongs to this account.
  const shipment = await prisma.shipment.findFirst({
    where: { organizationId: conn.organizationId, freightAmount: { not: null }, awbCode: { not: null } },
    select: { awbCode: true },
    orderBy: { createdAt: "desc" },
  });
  const awb = shipment?.awbCode ?? "80126116280";

  console.log(`
# org            : ${org?.name}
# stored loginId : ${c.loginId}          <- what is saved right now
# licenceKey     : ${c.licenceKey.length} chars
# clientId       : ${c.clientId ? `${c.clientId.length} chars` : "(none stored — not required)"}
# last synced    : ${conn.lastSyncedAt?.toISOString() ?? "never"}
# probe waybill  : ${awb} (billed on a Bluedart tax invoice to NDA821166)
`);

  console.log(`# 1. Mint the JWT. Note it needs NO credentials — that is why a 200 here proves nothing.`);
  console.log(`curl -s -X POST '${GATEWAY}/token/v1/login' -H 'Content-Type: application/json'\n`);

  console.log(`# 2. Track. Substitute the JWT from step 1.`);
  console.log(
    [
      `curl -s -G '${GATEWAY}/tracking/v1' \\`,
      `  --data-urlencode 'handler=tnt' \\`,
      `  --data-urlencode 'action=custawbquery' \\`,
      `  --data-urlencode 'awb=awb' \\`,
      `  --data-urlencode 'loginid=${c.loginId}' \\`,
      `  --data-urlencode 'numbers=${awb}' \\`,
      `  --data-urlencode 'lickey=${mask(c.licenceKey)}' \\`,
      `  --data-urlencode 'format=xml' \\`,
      `  --data-urlencode 'scan=1' \\`,
      `  -H "JWTToken: $JWT"`,
    ].join("\n")
  );
  if (!REVEAL) console.log(`\n# (licence key masked — re-run with --reveal to get a runnable line)`);

  console.log(`
# Do NOT add verno=1. It appears in Bluedart's published examples and changes
# the reply to "License Mismatch" — which, per the control below, still does not
# mean the licence is wrong.
`);

  if (process.argv.includes("--run") || process.argv.includes("--control")) {
    const token = await fetchToken(c);
    const hit = async (lickey: string, loginid: string, numbers: string) => {
      const url = new URL(`${GATEWAY}/tracking/v1`);
      for (const [k, v] of Object.entries({
        handler: "tnt", action: "custawbquery", awb: "awb",
        loginid, numbers, lickey, format: "xml", scan: "1",
      })) url.searchParams.set(k, v);
      const res = await fetch(url, { headers: { JWTToken: token, Accept: "application/xml" }, signal: AbortSignal.timeout(20_000) });
      const text = await res.text();
      return `HTTP ${res.status}  ${text.length}b  ${text.replace(/\s+/g, " ").trim()}`;
    };

    console.log(`--- executed here ---`);
    console.log(`stored creds        : ${await hit(c.licenceKey, c.loginId, awb)}`);

    if (process.argv.includes("--control")) {
      // The control that overturned three earlier diagnoses: if a deliberately
      // invalid licence key returns the SAME body, then the response carries no
      // information about whether the real credentials are right.
      console.log(`NDA821166 loginid   : ${await hit(c.licenceKey, "NDA821166", awb)}`);
      console.log(`GARBAGE loginid     : ${await hit(c.licenceKey, "GARBAGE99999", awb)}`);
      console.log(`INVALID licence key : ${await hit("f".repeat(c.licenceKey.length), c.loginId, awb)}`);
      console.log(`nonexistent waybill : ${await hit(c.licenceKey, c.loginId, "99999999999")}`);
      console.log(`
# If those five lines are identical, the endpoint is not evaluating credentials
# at all, and no error string from it can diagnose the connection.`);
    }
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
