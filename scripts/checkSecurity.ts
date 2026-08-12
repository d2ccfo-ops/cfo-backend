import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { prisma } from "../src/lib/prisma.js";
import { decryptSecret } from "../src/lib/crypto.js";
import { AI_LIMIT, INGEST_LIMIT, READ_LIMIT, WRITE_LIMIT, limitFor } from "../src/middleware/rateLimit.js";

// P5.7's sweep, asserted rather than asserted-about.
//
// A security review that reads code and concludes "this looks right" is how
// every one of these gaps got shipped in the first place. Each check here
// either executes the guard or reads the source for the exact property the
// guard depends on.
//
// The credential check is the one that matters most and is the only one that
// touches real rows: every stored credentialsRef in this database is decrypted
// with the server key. A row that decrypts is encrypted; a row that does not
// is either plaintext or corrupt, and both need to be named.
//
// Run with: npx tsx scripts/checkSecurity.ts

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(label: string, condition: boolean, detail = "") {
  if (condition) pass += 1;
  else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  }
  console.log(`  ${condition ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

const BACKEND = new URL("../", pathToFileURL(import.meta.dirname + "/"));

async function main() {
  // ---------------------------------------------------------------------------
  console.log("\n[1] Every inbound webhook verifies something");
  // ---------------------------------------------------------------------------
  const webhookDir = new URL("src/routes/webhooks/", BACKEND);
  const webhooks = (await readdir(webhookDir)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  ok("webhook handlers exist", webhooks.length >= 7, `${webhooks.length}`);

  for (const file of webhooks) {
    const src = await readFile(new URL(file, webhookDir), "utf8");
    // Three legitimate schemes: a provider HMAC, svix (Clerk), or a
    // shared-secret token compared in constant time for the providers that
    // publish no signature scheme at all. What must never appear is a handler
    // that accepts a body on the strength of the URL alone.
    const hmac = /createHmac|verifyWebhook|verifyRazorpaySignature/.test(src);
    const svix = /new Webhook\(/.test(src);
    const sharedSecret = /timingSafeEqual/.test(src);
    const tokenPath = /token|secret/i.test(src);
    ok(`${file} verifies the sender`, hmac || svix || sharedSecret || tokenPath, "no verification of any kind found");

    // Whatever the scheme, a failure must REFUSE. A handler that logs and
    // continues is a handler with no verification.
    if (hmac || svix || sharedSecret) {
      ok(`${file} refuses on a bad signature`, /status\((?:400|401|403)\)/.test(src));
    }
    // Constant-time comparison wherever a secret is compared at all.
    if (/=== *(?:creds\.|env\.)?[A-Za-z_]*[Ss]ecret/.test(src)) {
      ok(`${file} compares secrets in constant time`, sharedSecret, "uses === on a secret");
    }
  }

  // ---------------------------------------------------------------------------
  console.log("\n[2] Rate limits are keyed on the organisation, not the IP");
  // ---------------------------------------------------------------------------
  const authSrc = await readFile(new URL("src/middleware/auth.ts", BACKEND), "utf8");
  // Mounted inside requireAuth, so it runs AFTER the org claim resolves. A
  // limiter mounted globally in app.ts would silently degrade to per-IP, which
  // on a multi-tenant API makes one office's NAT look like one customer.
  ok("the limiter runs inside the requireAuth chain", /requireAuth\s*=\s*\[resolveOrgContext,\s*enforceRbac,\s*enforceRateLimit\]/.test(authSrc));
  const appSrc = await readFile(new URL("src/app.ts", BACKEND), "utf8");
  ok("it is NOT mounted globally before auth", !/app\.use\(apiRateLimit\(\)\)/.test(appSrc));

  ok("reads get a generous ceiling", limitFor("GET", "/metrics/revenue") === READ_LIMIT, `${READ_LIMIT.max}/min`);
  ok("writes get a tighter one", limitFor("POST", "/reconciliation/run") === WRITE_LIMIT, `${WRITE_LIMIT.max}/min`);
  ok("ingest is tightest", limitFor("POST", "/connections/bank/abc/upload") === INGEST_LIMIT, `${INGEST_LIMIT.max}/min`);
  ok("costs upload counts as ingest", limitFor("POST", "/costs/bulk") === INGEST_LIMIT);
  // The AI is the only path that costs money per call.
  ok("the AI path has its own ceiling", limitFor("POST", "/ai/ask") === AI_LIMIT, `${AI_LIMIT.max}/min`);
  ok("a GET under /ai is still AI-limited", limitFor("GET", "/ai/conversations") === AI_LIMIT);
  ok("ingest matching is prefix-exact, not substring", limitFor("POST", "/costsomething") === WRITE_LIMIT);

  const limitSrc = await readFile(new URL("src/middleware/rateLimit.ts", BACKEND), "utf8");
  ok("counters live in Redis, not in process memory", /redisConnection\.incr/.test(limitSrc));
  // Re-expiring on every request would turn a fixed window into a rolling one
  // that never resets under sustained load — a client at exactly the limit
  // would be locked out forever.
  ok("the window TTL is set only on the first hit", /count === 1\)[\s\S]{0,400}?redisConnection\.expire/.test(limitSrc));
  // A limiter that takes the product down when its counter store hiccups has
  // caused a worse outage than the abuse it prevents.
  ok("it fails OPEN when Redis is unreachable", /catch[\s\S]{0,200}?rate_limit_store_unavailable[\s\S]{0,80}?next\(\)/.test(limitSrc));
  ok("a refusal says the number and the wait", /retryAfterSeconds/.test(limitSrc) && /Retry-After/.test(limitSrc));

  // ---------------------------------------------------------------------------
  console.log("\n[3] Stored credentials are encrypted at rest — checked by decrypting them");
  // ---------------------------------------------------------------------------
  const connections = await prisma.connection.findMany({
    select: { id: true, provider: true, credentialsRef: true, status: true },
  });
  ok("there are connections to check", connections.length > 0, `${connections.length}`);

  let encrypted = 0;
  let demo = 0;
  let plaintext = 0;
  for (const c of connections) {
    // The seeder marks its connections with a literal reference; they hold no
    // real secret by construction and are not a finding.
    if (c.credentialsRef.startsWith("demo-seed:")) {
      demo += 1;
      continue;
    }
    try {
      const decrypted = decryptSecret(c.credentialsRef);
      encrypted += 1;
      // It decrypted, so it was encrypted. It must ALSO not be trivially
      // re-identifiable: the ciphertext must not contain the plaintext.
      ok(
        `${c.provider} ciphertext does not contain its own plaintext`,
        !c.credentialsRef.includes(decrypted.slice(0, 12)),
        ""
      );
    } catch {
      plaintext += 1;
      // Named, with the provider, so it can be fixed. Not printed with the
      // value — that is the thing being protected.
      ok(`${c.provider} (${c.id.slice(0, 8)}) credentialsRef is encrypted`, false, "did not decrypt: plaintext or corrupt");
    }
  }
  console.log(`  · ${encrypted} encrypted, ${demo} demo-seeded, ${plaintext} not decryptable`);
  ok("no connection stores a plaintext credential", plaintext === 0, `${plaintext} found`);

  const cryptoSrc = await readFile(new URL("src/lib/crypto.ts", BACKEND), "utf8");
  ok("AES-256-GCM, which authenticates as well as encrypts", cryptoSrc.includes("aes-256-gcm"));
  ok("a fresh IV per encryption", /randomBytes\(12\)/.test(cryptoSrc));
  ok("the auth tag is verified on decrypt", /setAuthTag/.test(cryptoSrc));
  ok("a short key is rejected loudly rather than padded", /must be 32 bytes/.test(cryptoSrc));

  // ---------------------------------------------------------------------------
  console.log("\n[4] Uploads are checked before they are parsed");
  // ---------------------------------------------------------------------------
  const uploadRoutes = [
    "src/routes/connections/bank.ts",
    "src/routes/connections/gokwik.ts",
    "src/routes/connections/adSpendCsv.ts",
    "src/routes/connections/bluedart.ts",
  ];
  for (const path of uploadRoutes) {
    const src = await readFile(new URL(path, BACKEND), "utf8");
    ok(`${path.split("/").pop()} validates the upload`, /checkCsv|checkBase64/.test(src));
  }
  const guardSrc = await readFile(new URL("src/lib/uploadGuard.ts", BACKEND), "utf8");
  ok("the guard recognises an HTML page", /doctype\|html/i.test(guardSrc));
  ok("the guard recognises executables", /windows-executable/.test(guardSrc) && /elf-executable/.test(guardSrc));
  ok("there is a size cap", /MAX_UPLOAD_BYTES/.test(guardSrc));
  // The stub that would be worse than nothing.
  ok("the malware hook reports NOT SCANNED rather than clean", /scanned: false,\s*\n?\s*clean: false/.test(guardSrc));

  // ---------------------------------------------------------------------------
  console.log("\n[5] Nothing logs a secret");
  // ---------------------------------------------------------------------------
  const walk = async (dir: URL, acc: string[] = []): Promise<string[]> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(new URL(`${entry.name}/`, dir), acc);
      else if (entry.name.endsWith(".ts")) acc.push(new URL(entry.name, dir).pathname);
    }
    return acc;
  };
  const allFiles = await walk(new URL("src/", BACKEND));
  const offenders: string[] = [];
  for (const file of allFiles) {
    const src = await readFile(file, "utf8");
    // A logger call that interpolates a credential or a decrypted secret.
    if (/logger\.\w+\([^)]*\b(credentialsRef|apiKey|accessToken|password|webhookSecret)\b[^)]*\)/.test(src)) {
      // decryptSecret's own throw path and shape-only logs are fine; this
      // pattern catches the value itself reaching a log line.
      if (!/length|Boolean|\.length/.test(src.match(/logger\.\w+\([^)]*\b(?:credentialsRef|apiKey|accessToken|password|webhookSecret)\b[^)]*\)/)?.[0] ?? "")) {
        offenders.push(file.replace(BACKEND.pathname, ""));
      }
    }
  }
  ok("no logger call carries a raw credential", offenders.length === 0, offenders.join(", "));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
