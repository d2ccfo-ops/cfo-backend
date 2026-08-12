import { decryptSecret, encryptSecret } from "../src/lib/crypto.js";
import { prisma } from "../src/lib/prisma.js";

// Changes the stored Bluedart login id, keeping the licence key untouched.
//
// The Connections page can do this too, by re-entering both values — but that
// requires having the licence key to hand, and it is already encrypted at rest
// here. This swaps just the one field.
//
// Run with: npx tsx scripts/setBluedartLoginId.ts NDA821166
//           npx tsx scripts/setBluedartLoginId.ts NDA821166 --org <organizationId>
//
// Prints credential SHAPES only, never values.

async function main() {
  const loginId = process.argv[2];
  if (!loginId || loginId.startsWith("--")) {
    console.log("usage: npx tsx scripts/setBluedartLoginId.ts <LOGIN_ID> [--org <organizationId>]");
    process.exit(1);
  }
  const orgFlag = process.argv.indexOf("--org");
  const organizationId = orgFlag > -1 ? process.argv[orgFlag + 1] : undefined;

  const conns = await prisma.connection.findMany({
    where: { provider: "BLUEDART", ...(organizationId ? { organizationId } : {}) },
    select: { id: true, organizationId: true, credentialsRef: true, externalAccountId: true },
  });
  if (conns.length === 0) {
    console.log("no BLUEDART connection found");
    process.exit(1);
  }

  for (const conn of conns) {
    const org = await prisma.organization.findUnique({
      where: { id: conn.organizationId },
      select: { name: true },
    });
    let creds: { loginId: string; licenceKey: string; clientId?: string; clientSecret?: string };
    try {
      creds = JSON.parse(decryptSecret(conn.credentialsRef!));
    } catch {
      // The demo org holds a placeholder that is not a real ciphertext. Skipped
      // rather than failed on, so one bad row does not block the real one.
      console.log(`skipped ${org?.name} — credentials are not decryptable (placeholder)`);
      continue;
    }

    if (creds.loginId === loginId) {
      console.log(`${org?.name}: already ${loginId}, unchanged`);
      continue;
    }

    const updated = { ...creds, loginId };
    await prisma.connection.update({
      where: { id: conn.id },
      // externalAccountId is what the Connections page prints, so it moves too.
      data: { credentialsRef: encryptSecret(JSON.stringify(updated)), externalAccountId: loginId },
    });
    console.log(
      `${org?.name}: loginId ${creds.loginId} -> ${loginId} (licence key untouched, ${creds.licenceKey.length} chars)`
    );
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
