-- Prompt-cache accounting on agent_runs.
--
-- The AI orchestrator is an agentic loop: one question is several API calls,
-- and each resends the system prompt, every tool schema and every tool result
-- so far. Measured on two real questions that was 55,667 input tokens against
-- 3,778 output. Prompt caching now re-bills most of that prefix at ~10% of the
-- input rate, but the API reports cache reads and cache writes OUTSIDE
-- input_tokens, so without these two columns the existing inputTokens figure
-- would simply collapse and look like a bug rather than a saving.
--
-- Separate counters, not one total: the three bill at three different rates,
-- and a sum would make it impossible to tell a working cache from a cold one.
--
-- Backfilled to 0, which is truthful for every existing row — those ran before
-- caching existed and had their whole prompt billed as inputTokens. Rows on
-- either side of this migration are therefore NOT comparable on inputTokens
-- alone.
ALTER TABLE "agent_runs" ADD COLUMN "cacheReadTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "agent_runs" ADD COLUMN "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0;
