import { decryptSecret, encryptSecret } from "../src/lib/crypto.js";
import { prisma } from "../src/lib/prisma.js";

// Stores Bluedart's `tracking_license_key` alongside the existing
// `license_key`. They are different 32-char values and Bluedart's onboarding
// sheet lists them as separate fields; tracking uses this one in preference.
//
// Takes the key from the BLUEDART_TRACKING_KEY environment variable rather than
// argv, so it never lands in shell history:
//
//   read -rs BLUEDART_TRACKING_KEY && export BLUEDART_TRACKING_KEY
//   npx tsx scripts/setBluedartTrackingKey.ts
//
// Prints credential SHAPES only, never values.

async function main() {
  const key = process.env.BLUEDART_TRACKING_KEY;
  if (!key) {
    console.log("set BLUEDART_TRACKING_KEY first:\n  read -rs BLUEDART_TRACKING_KEY && export BLUEDART_TRACKING_KEY");
    process.exit(1);
  }

  const orgFlag = process.argv.indexOf("--org");
  const organizationId = orgFlag > -1 ? process.argv[orgFlag + 1] : undefined;

  const conns = await prisma.connection.findMany({
    where: { provider: "BLUEDART", ...(organizationId ? { organizationId } : {}) },
    select: { id: true, organizationId: true, credentialsRef: true },
  });

  for (const conn of conns) {
    const org = await prisma.organization.findUnique({
      where: { id: conn.organizationId },
      select: { name: true },
    });
    let creds: { loginId: string; licenceKey: string; trackingLicenceKey?: string };
    try {
      creds = JSON.parse(decryptSecret(conn.credentialsRef!));
    } catch {
      console.log(`skipped ${org?.name} — credentials are not decryptable (placeholder)`);
      continue;
    }

    await prisma.connection.update({
      where: { id: conn.id },
      data: { credentialsRef: encryptSecret(JSON.stringify({ ...creds, trackingLicenceKey: key })) },
    });
    console.log(
      `${org?.name}: trackingLicenceKey stored (${key.length} chars), ` +
        `${key === creds.licenceKey ? "SAME as license_key — check the sheet" : "distinct from license_key"}, ` +
        `loginId ${creds.loginId} unchanged`
    );
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
