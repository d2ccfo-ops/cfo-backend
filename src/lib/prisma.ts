import { PrismaClient } from "@prisma/client";

// Single shared client. Tenant scoping is enforced at the call site (see
// middleware/auth.ts + modules/*/repo.ts), not here — Prisma's client itself
// has no concept of "current org."
export const prisma = new PrismaClient();
