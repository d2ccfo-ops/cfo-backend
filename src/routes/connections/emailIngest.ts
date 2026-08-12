import { Router } from "express";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../../middleware/auth.js";
import { generateIngestToken } from "../../modules/ingest/inboundEmail.js";

export const emailIngestRouter = Router();

// The merchant-facing half of inbound email: shows the org's ingest address,
// the log of what has arrived, and rotation.

function addressFor(token: string): string | null {
  // Without a configured inbound domain there is no routable address to show —
  // the webhook URL still works (for a relay or manual POST), and the UI says
  // which situation it is in rather than printing an address that bounces.
  return env.EMAIL_INGEST_DOMAIN ? `docs-${token}@${env.EMAIL_INGEST_DOMAIN}` : null;
}

async function getOrCreateAddress(organizationId: string) {
  const existing = await prisma.emailIngestAddress.findFirst({
    where: { organizationId, disabledAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return existing;
  try {
    return await prisma.emailIngestAddress.create({
      data: { organizationId, token: generateIngestToken() },
    });
  } catch (err) {
    // A concurrent page load created the active address first; the partial
    // unique index (one active address per org) fired. Re-read the winner
    // rather than returning a second active address that would split which one
    // the merchant's forwarding rule can use.
    if ((err as { code?: string }).code === "P2002") {
      const won = await prisma.emailIngestAddress.findFirst({ where: { organizationId, disabledAt: null } });
      if (won) return won;
    }
    throw err;
  }
}

emailIngestRouter.get("/", ...requireAuth, async (req, res) => {
  const organizationId = req.auth!.organizationId;
  try {
    const address = await getOrCreateAddress(organizationId);
    const emails = await prisma.inboundEmail.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        fromAddress: true,
        subject: true,
        attachmentCount: true,
        status: true,
        outcomes: true,
        createdAt: true,
      },
    });
    res.json({
      token: address.token,
      address: addressFor(address.token),
      webhookUrl: `${env.BACKEND_URL}/webhooks/inbound-email/${address.token}`,
      domainConfigured: Boolean(env.EMAIL_INGEST_DOMAIN),
      emails: emails.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
    });
  } catch (err) {
    logger.error({ err }, "email_ingest_read_failed");
    res.status(500).json({ error: "read_failed" });
  }
});

// Rotation is the recovery from a leaked address. The old address is disabled,
// not deleted: its history stays attributable, and a disabled row is explicit
// proof of WHEN it stopped being valid.
emailIngestRouter.post("/rotate", ...requireAuth, async (req, res) => {
  const organizationId = req.auth!.organizationId;
  try {
    const [, created] = await prisma.$transaction([
      prisma.emailIngestAddress.updateMany({
        where: { organizationId, disabledAt: null },
        data: { disabledAt: new Date() },
      }),
      prisma.emailIngestAddress.create({ data: { organizationId, token: generateIngestToken() } }),
    ]);
    logger.info({ organizationId }, "email_ingest_rotated");
    res.json({
      token: created.token,
      address: addressFor(created.token),
      webhookUrl: `${env.BACKEND_URL}/webhooks/inbound-email/${created.token}`,
      domainConfigured: Boolean(env.EMAIL_INGEST_DOMAIN),
    });
  } catch (err) {
    logger.error({ err }, "email_ingest_rotate_failed");
    res.status(500).json({ error: "rotate_failed" });
  }
});