import { prisma } from "../src/lib/prisma.js";
import { decryptSecret } from "../src/lib/crypto.js";

// Prints a ready-to-paste curl for the GoKwik order API.
//
// Exists because the credentials are encrypted at rest, so there is no way to
// hand someone a literal curl without first decrypting them — and printing an
// app secret into a chat log or a ticket is how secrets leak. This writes it to
// YOUR terminal instead.
//
// Run with: npx tsx scripts/printGokwikCurl.ts
// Add --run to execute it here instead of printing it.

const HOST = process.env.GOKWIK_API_HOST ?? "https://api.gokwik.co";

async function main() {
  const conn = await prisma.connection.findFirst({
    where: { provider: "GOKWIK" },
    orderBy: { createdAt: "desc" },
    select: { id: true, externalAccountId: true, credentialsRef: true, organizationId: true },
  });
  if (!conn) {
    console.log("no GOKWIK connection found — connect it on the Connections page first");
    process.exit(1);
  }
  const org = await prisma.organization.findUnique({
    where: { id: conn.organizationId },
    select: { name: true },
  });
  const c = JSON.parse(decryptSecret(conn.credentialsRef)) as {
    merchantId: string;
    appId: string;
    appSecret: string;
  };

  const url = `${HOST}/v1/order/list?mid=${encodeURIComponent(c.merchantId)}&limit=1`;
  const curl = [
    `curl -i '${url}' \\`,
    `  -H 'appid: ${c.appId}' \\`,
    `  -H 'appsecret: ${c.appSecret}'`,
  ].join("\n");

  console.log(`\n# org: ${org?.name}   merchant: ${c.merchantId}\n`);
  console.log(curl);
  console.log(`
# Expected today — note the HTTP status is 200 while the BODY says 500:
#   HTTP/2 200
#   {"statusCode":500,"statusMessage":"Unable to get order details, Please try agian!","data":{}}
#
# Drop the query string entirely and you get the identical error, which is the
# proof that the endpoint fails before it reads the request:
#   curl -i '${HOST}/v1/order/list' -H 'appid: …' -H 'appsecret: …'
`);

  if (process.argv.includes("--run")) {
    const res = await fetch(url, { headers: { appid: c.appId, appsecret: c.appSecret } });
    console.log(`--- executed here ---\nHTTP ${res.status}\n${await res.text()}`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
