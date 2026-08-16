-- Indexes for the SQL-aggregated metric endpoints. All additive; no data
-- changes. Each serves a where-clause that previously fell back to an
-- organizationId-prefix scan plus a heap filter over the org's entire history.

-- Every metric endpoint's "this org's orders in this window" scan — the
-- revenue ladder alone runs it three times per request.
CREATE INDEX "orders_organizationId_placedAt_idx" ON "orders"("organizationId", "placedAt");

-- The reconciliation summary's channel dropdown (GROUP BY channel org-wide).
CREATE INDEX "orders_organizationId_channel_idx" ON "orders"("organizationId", "channel");

-- The captured-status payment filter (COD deposits groupBy, payment leg).
CREATE INDEX "payments_organizationId_status_idx" ON "payments"("organizationId", "status");

-- Cash-received window sums and the trend's six-month CREDIT bucketing.
CREATE INDEX "bank_transactions_organizationId_direction_valueDate_idx" ON "bank_transactions"("organizationId", "direction", "valueDate");
