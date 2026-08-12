import { prisma } from "../src/lib/prisma.js";
import { decryptSecret, encryptSecret } from "../src/lib/crypto.js";

// One-time repair for P5.7.
//
// scripts/checkSecurity.ts decrypts every stored credentialsRef with the
// server key. A row that does not decrypt is either plaintext or corrupt, and
// it found one: a BANK connection created on 2026-08-07, before the bank
// connect route began encrypting what it wrote.
//
// It is re-encrypted in place, preserving the value byte for byte. That is
// safe here specifically because nothing decrypts a BANK credentialsRef —
// the bank connector is a documented no-op and statements arrive by upload —
// so no consumer can be relying on reading it raw. For any other provider
// this script would refuse rather than guess.
//
// Nothing is printed but shapes. The whole point of the row is that its
// contents should not be readable from a terminal history.
//
// Run with: npx tsx scripts/encryptLegacyCredentials.ts [--apply]

const APPLY = process.argv.includes("--apply");

// Providers whose credentialsRef is never decrypted by any connector. Anything
// outside this set is REPORTED, not rewritten: re-encrypting a value some
// connector reads raw would break the connection in a way that only shows up
// at the next sync.
const SAFE_TO_REWRITE = new Set(["BANK"]);

async function main() {
  const rows = await prisma.connection.findMany({
    select: { id: true, provider: true, credentialsRef: true, createdAt: true },
  });

  let encrypted = 0;
  let demo = 0;
  let fixed = 0;
  let refused = 0;

  for (const r of rows) {
    if (r.credentialsRef.startsWith("demo-seed:")) {
      demo += 1;
      continue;
    }
    try {
      decryptSecret(r.credentialsRef);
      encrypted += 1;
      continue;
    } catch {
      // Not encrypted.
    }

    if (!SAFE_TO_REWRITE.has(r.provider)) {
      refused += 1;
      console.log(
        `REFUSING  ${r.provider} ${r.id.slice(0, 10)} (created ${r.createdAt.toISOString().slice(0, 10)}, ${r.credentialsRef.length} chars) — a connector reads this provider's credentials, so rewriting it could break the connection silently. Re-connect it from the Connections page instead.`
      );
      continue;
    }

    console.log(
      `${APPLY ? "ENCRYPTING" : "WOULD ENCRYPT"}  ${r.provider} ${r.id.slice(0, 10)} (created ${r.createdAt.toISOString().slice(0, 10)}, ${r.credentialsRef.length} chars)`
    );
    if (APPLY) {
      await prisma.connection.update({
        where: { id: r.id },
        data: { credentialsRef: encryptSecret(r.credentialsRef) },
      });
      await prisma.auditLog.create({
        data: {
          organizationId: (await prisma.connection.findUniqueOrThrow({ where: { id: r.id }, select: { organizationId: true } })).organizationId,
          actorType: "SYSTEM",
          actorId: "encryptLegacyCredentials",
          action: "connection.credentials_encrypted",
          entityType: "CONNECTION",
          entityId: r.id,
          metadata: {
            provider: r.provider,
            reason: "P5.7: this credentialsRef predated encryption at rest and was stored in plaintext. Re-encrypted in place; the value is unchanged.",
          },
        },
      });
    }
    fixed += 1;
  }

  console.log(
    `\n${rows.length} connections: ${encrypted} already encrypted, ${demo} demo-seeded, ${fixed} ${APPLY ? "encrypted" : "would be encrypted"}, ${refused} refused.`
  );
  if (!APPLY && fixed > 0) console.log("\nRe-run with --apply to make the change.");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
