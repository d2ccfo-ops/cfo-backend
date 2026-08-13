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

  // ---------------------------------------------------------------------------
  // THE SECRET IS NOT PRINTED. IT IS READ FROM THE ENVIRONMENT AT RUN TIME.
  // ---------------------------------------------------------------------------
  // This used to interpolate c.appSecret directly into the curl line, so the
  // merchant's live GoKwik credential landed in terminal scrollback, shell
  // history, and any transcript of a debugging session — including one pasted
  // into a chat to ask why the call was failing.
  //
  // The emitted command references $GOKWIK_APPSECRET instead. Whoever runs it
  // exports the value themselves, which is the same rule this project already
  // applies everywhere else: debug output prints SHAPES, never values.
  const url = `${HOST}/v1/order/list?mid=${encodeURIComponent(c.merchantId)}&limit=1`;
  const curl = [
    `export GOKWIK_APPSECRET='<paste the app secret>'   # not printed here on purpose`,
    `curl -i '${url}' \\`,
    `  -H 'appid: ${c.appId}' \\`,
    `  -H "appsecret: $GOKWIK_APPSECRET"`,
  ].join("\n");

  console.log(`\n# org: ${org?.name}   merchant: ${c.merchantId}`);
  // Shape only, so a wrong-length or empty credential is still diagnosable
  // without the value ever being displayed.
  console.log(`# appSecret: ${c.appSecret.length} chars, ends "${c.appSecret.slice(-4)}"\n`);
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
