-- P5.1 (§12.2): the four roles the enum was missing.
--
-- Additive only. MEMBER stays, because Postgres enum values cannot be removed
-- without a table rewrite and every membership row currently carries it;
-- middleware/rbac.ts maps MEMBER to ANALYST at decision time.
ALTER TYPE "MembershipRole" ADD VALUE IF NOT EXISTS 'FINANCE_MANAGER';
ALTER TYPE "MembershipRole" ADD VALUE IF NOT EXISTS 'ACCOUNTANT';
ALTER TYPE "MembershipRole" ADD VALUE IF NOT EXISTS 'ANALYST';
ALTER TYPE "MembershipRole" ADD VALUE IF NOT EXISTS 'EXTERNAL_CA';
