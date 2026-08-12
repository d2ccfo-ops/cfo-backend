-- P4.7: record the answer-verification verdict on every AI run.
--
-- Additive and nullable: existing runs predate the check and must read as
-- "not checked", which is a different fact from "checked and clean".
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "verification" JSONB;
