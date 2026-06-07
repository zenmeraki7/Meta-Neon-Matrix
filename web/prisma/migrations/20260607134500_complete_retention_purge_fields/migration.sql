ALTER TABLE "BillingEvent"
  ADD COLUMN IF NOT EXISTS "purgeAfter" TIMESTAMP(3) NOT NULL DEFAULT (now() + interval '365 days');

UPDATE "BillingEvent"
SET "purgeAfter" = COALESCE("purgeAfter", "createdAt" + interval '365 days');

ALTER TABLE "BillingEvent"
  ALTER COLUMN "purgeAfter" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "BillingEvent_shop_purgeAfter_idx"
  ON "BillingEvent"("shop", "purgeAfter");

ALTER TABLE "OperationStageProgress"
  ADD COLUMN IF NOT EXISTS "purgeAfter" TIMESTAMP(3) NOT NULL DEFAULT (now() + interval '30 days');

UPDATE "OperationStageProgress"
SET "purgeAfter" = COALESCE("purgeAfter", COALESCE("completedAt", "updatedAt") + interval '30 days');

ALTER TABLE "OperationStageProgress"
  ALTER COLUMN "purgeAfter" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "OperationStageProgress_shop_purgeAfter_idx"
  ON "OperationStageProgress"("shop", "purgeAfter");

ALTER TABLE "MirrorAnomaly"
  ADD COLUMN IF NOT EXISTS "purgeAfter" TIMESTAMP(3) NOT NULL DEFAULT (now() + interval '30 days');

UPDATE "MirrorAnomaly"
SET "purgeAfter" = COALESCE("purgeAfter", "createdAt" + interval '30 days');

ALTER TABLE "MirrorAnomaly"
  ALTER COLUMN "purgeAfter" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "MirrorAnomaly_shop_purgeAfter_idx"
  ON "MirrorAnomaly"("shop", "purgeAfter");

ALTER TABLE "OutboxEvent"
  ADD COLUMN IF NOT EXISTS "purgeAfter" TIMESTAMP(3);

UPDATE "OutboxEvent"
SET "purgeAfter" = COALESCE("purgeAfter", COALESCE("dispatchedAt", "updatedAt") + interval '7 days')
WHERE "status" = 'DISPATCHED';

CREATE INDEX IF NOT EXISTS "OutboxEvent_shop_status_purgeAfter_idx"
  ON "OutboxEvent"("shop", "status", "purgeAfter");
