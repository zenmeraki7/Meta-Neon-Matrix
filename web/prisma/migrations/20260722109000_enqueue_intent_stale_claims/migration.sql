-- Atomic, reclaimable queue-intent dispatch claims.
ALTER TABLE "OperationEnqueueIntent" ADD COLUMN IF NOT EXISTS "dispatchStartedAt" TIMESTAMP(3);
ALTER TABLE "OperationEnqueueIntent" ADD COLUMN IF NOT EXISTS "dispatchHeartbeatAt" TIMESTAMP(3);
ALTER TABLE "OperationEnqueueIntent" ADD COLUMN IF NOT EXISTS "dispatchOwner" TEXT;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "OperationEnqueueIntent_status_dispatchHeartbeatAt_id_idx"
  ON "OperationEnqueueIntent" ("status", "dispatchHeartbeatAt", "id");
