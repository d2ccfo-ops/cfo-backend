-- Who is signed in, from where, on what — one row per Clerk session — plus a
-- cache of IP-to-place lookups so the third-party call happens once per address
-- rather than once per request.
--
-- Both tables are new; nothing existing is altered.

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" TEXT NOT NULL,
    "clerkSessionId" TEXT NOT NULL,
    "clerkUserId" TEXT NOT NULL,
    "organizationId" TEXT,
    "signedInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 1,
    "ip" TEXT,
    "city" TEXT,
    "region" TEXT,
    "country" TEXT,
    "countryCode" TEXT,
    "timezone" TEXT,
    "network" TEXT,
    "hosting" BOOLEAN,
    "userAgent" TEXT,
    "browser" TEXT,
    "os" TEXT,
    "deviceKind" TEXT,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_clerkSessionId_key" ON "user_sessions"("clerkSessionId");

-- CreateIndex
CREATE INDEX "user_sessions_clerkUserId_signedInAt_idx" ON "user_sessions"("clerkUserId", "signedInAt");

-- CreateIndex
CREATE INDEX "user_sessions_lastSeenAt_idx" ON "user_sessions"("lastSeenAt");

-- CreateIndex
CREATE INDEX "user_sessions_organizationId_lastSeenAt_idx" ON "user_sessions"("organizationId", "lastSeenAt");

-- CreateTable
CREATE TABLE "ip_geo" (
    "ip" TEXT NOT NULL,
    "city" TEXT,
    "region" TEXT,
    "country" TEXT,
    "countryCode" TEXT,
    "timezone" TEXT,
    "network" TEXT,
    "hosting" BOOLEAN,
    "source" TEXT NOT NULL,
    "error" TEXT,
    "lookedUpAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ip_geo_pkey" PRIMARY KEY ("ip")
);
