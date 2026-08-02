-- This migration must run without a surrounding transaction.
CREATE UNIQUE INDEX CONCURRENTLY "PreviewContract_shop_execution_nonnull_uq"
  ON "PreviewContract" ("shop", "executionId") WHERE "executionId" IS NOT NULL;

CREATE INDEX CONCURRENTLY "OutboxEvent_claim_idx"
  ON "OutboxEvent" ("nextAttemptAt", "createdAt", "id")
  WHERE "statusNormalized" = 'PENDING'::"OutboxEventStatus";

CREATE INDEX CONCURRENTLY "OperationEnqueueIntent_claim_idx"
  ON "OperationEnqueueIntent" ("nextAttemptAt", "id")
  WHERE "status" IN ('PENDING'::"OperationEnqueueIntentStatus", 'FAILED'::"OperationEnqueueIntentStatus");

CREATE INDEX CONCURRENTLY "OperationEnqueueIntent_stale_dispatch_idx"
  ON "OperationEnqueueIntent" ("dispatchLeaseExpiresAt", "id")
  WHERE "status" = 'DISPATCHING'::"OperationEnqueueIntentStatus";

CREATE INDEX CONCURRENTLY "TargetSnapshotItem_execution_claim_idx"
  ON "TargetSnapshotItem" ("shop", "snapshotSetId", "nextAttemptAt", "ordinal", "id")
  WHERE "executionStatus" IN ('PENDING'::"TargetSnapshotItemExecutionStatus", 'DEFERRED'::"TargetSnapshotItemExecutionStatus");

CREATE INDEX CONCURRENTLY "TargetSnapshotItem_undo_claim_idx"
  ON "TargetSnapshotItem" ("shop", "snapshotSetId", "ordinal", "id")
  WHERE "undoStatus" = 'PENDING'::"TargetSnapshotItemUndoStatus";
