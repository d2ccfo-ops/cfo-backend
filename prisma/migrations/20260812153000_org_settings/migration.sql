-- P2.0: org-wide settings (as opposed to DashboardLayout, which is
-- per-user). One JSON bag; routes/preferences.ts's orgSettingsSchema is the
-- actual source of truth for which keys exist. Applied to the development
-- database with `prisma db push` (a `migrate dev` would have required
-- resetting a database holding real merchant data); this file exists so a
-- fresh deploy reproduces the same schema.

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN "settings" JSONB;
