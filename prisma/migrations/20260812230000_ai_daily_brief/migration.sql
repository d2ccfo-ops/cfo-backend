-- P4.5: one AI-written daily-brief narrative per organisation per day.
CREATE TABLE IF NOT EXISTS "ai_daily_briefs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "narrative" JSONB,
    "reason" TEXT,
    "figuresChecked" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT,
    "version" TEXT NOT NULL DEFAULT 'v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_daily_briefs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ai_daily_briefs_organizationId_day_key" ON "ai_daily_briefs"("organizationId", "day");
CREATE INDEX IF NOT EXISTS "ai_daily_briefs_organizationId_day_idx" ON "ai_daily_briefs"("organizationId", "day");
