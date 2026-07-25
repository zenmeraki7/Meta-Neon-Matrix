ALTER TABLE "AutomaticProductRuleRun"
  ADD COLUMN IF NOT EXISTS "processingStartedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "heartbeatAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "processingToken" TEXT,
  ADD COLUMN IF NOT EXISTS "processingOwner" TEXT,
  ADD COLUMN IF NOT EXISTS "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "queuedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "AutomaticProductRuleRun_shop_status_startedAt_idx"
  ON "AutomaticProductRuleRun"("shop", "status", "startedAt");

CREATE INDEX IF NOT EXISTS "AutomaticProductRuleRun_shop_status_heartbeatAt_idx"
  ON "AutomaticProductRuleRun"("shop", "status", "heartbeatAt");

CREATE INDEX IF NOT EXISTS "AutomaticProductRuleRun_shop_editHistoryId_idx"
  ON "AutomaticProductRuleRun"("shop", "editHistoryId");

CREATE INDEX IF NOT EXISTS "AutomaticProductRuleRun_automaticProductRuleId_status_createdAt_idx"
  ON "AutomaticProductRuleRun"("automaticProductRuleId", "status", "createdAt");
