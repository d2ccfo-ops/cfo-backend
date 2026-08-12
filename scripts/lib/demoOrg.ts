import { prisma } from "../../src/lib/prisma.js";

// Finds the organisation holding generated data.
//
// By the CONNECTION MARKER, never by the "DEMO — " name prefix. The seeder's own
// header says the marker is the load-bearing one and the name is the readable
// one, and this is the proof: the prefix went missing at some point during
// development while all 6,663 seeded orders and all seven demo connections were
// still exactly where they were left. Every script that looked the org up by
// name reported "no demo organisation" and refused to run.
//
// A marker on the parent row of everything the seeder wrote cannot drift out of
// step with the data the way a display name can.
export const DEMO_CREDENTIALS_PREFIX = "demo-seed:";
export const DEMO_NAME_PREFIX = "DEMO — ";

export interface DemoOrg {
  id: string;
  name: string;
  timezone: string;
  legalEntityId: string | null;
}

export async function findDemoOrg(): Promise<DemoOrg | null> {
  const conn = await prisma.connection.findFirst({
    where: { credentialsRef: { startsWith: DEMO_CREDENTIALS_PREFIX } },
    select: { organizationId: true, legalEntityId: true },
  });
  if (!conn) return null;

  const org = await prisma.organization.findUnique({
    where: { id: conn.organizationId },
    select: { id: true, name: true, timezone: true },
  });
  if (!org) return null;

  return { ...org, legalEntityId: conn.legalEntityId };
}

// Re-applies the display prefix if it has been lost. Cheap, idempotent, and
// worth doing on every audit run: the banner the frontend shows keys off the
// connection marker, but a human reading a list of organisations keys off this.
export async function ensureDemoNamePrefix(org: DemoOrg): Promise<string> {
  if (org.name.startsWith(DEMO_NAME_PREFIX)) return org.name;
  const name = `${DEMO_NAME_PREFIX}${org.name}`;
  await prisma.organization.update({ where: { id: org.id }, data: { name } });
  return name;
}
