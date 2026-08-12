-- §13 intelligence entities (P4.2)
CREATE TYPE "AgentRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'EXHAUSTED');
CREATE TYPE "AgentMessageRole" AS ENUM ('USER', 'ASSISTANT');

CREATE TABLE "agent_conversations" (
    "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "agent_conversations_pkey" PRIMARY KEY ("id"));
CREATE INDEX "agent_conversations_organizationId_userId_updatedAt_idx" ON "agent_conversations"("organizationId", "userId", "updatedAt");

CREATE TABLE "agent_messages" (
    "id" TEXT NOT NULL, "conversationId" TEXT NOT NULL, "organizationId" TEXT NOT NULL,
    "role" "AgentMessageRole" NOT NULL, "content" TEXT NOT NULL, "structured" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_messages_pkey" PRIMARY KEY ("id"));
CREATE INDEX "agent_messages_conversationId_createdAt_idx" ON "agent_messages"("conversationId", "createdAt");
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "agent_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL, "conversationId" TEXT NOT NULL, "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL, "question" TEXT NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'RUNNING', "model" TEXT NOT NULL,
    "turns" INTEGER NOT NULL DEFAULT 0, "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0, "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "finishedAt" TIMESTAMP(3),
    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id"));
CREATE INDEX "agent_runs_organizationId_startedAt_idx" ON "agent_runs"("organizationId", "startedAt");
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "agent_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "agent_tool_calls" (
    "id" TEXT NOT NULL, "runId" TEXT NOT NULL, "toolName" TEXT NOT NULL,
    "arguments" JSONB NOT NULL, "result" JSONB, "ok" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT, "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_tool_calls_pkey" PRIMARY KEY ("id"));
CREATE INDEX "agent_tool_calls_runId_createdAt_idx" ON "agent_tool_calls"("runId", "createdAt");
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
