-- This migration must run without a surrounding transaction.
CREATE UNIQUE INDEX CONCURRENTLY "UndoOperation_shop_execution_nonnull_uq"
  ON "UndoOperation" ("shop", "executionId") WHERE "executionId" IS NOT NULL;

CREATE INDEX CONCURRENTLY "ProductMediaMirror_reconcile_idx"
  ON "ProductMediaMirror" ("shop", "mirrorBatchId", "reconciliationCompletedAt", "mediaId")
  WHERE "isDeleted" = false;

CREATE INDEX CONCURRENTLY "ProductCollection_reconcile_idx"
  ON "ProductCollection" ("shop", "mirrorBatchId", "reconciliationCompletedAt", "productId", "collectionId")
  WHERE "isDeleted" = false;

CREATE UNIQUE INDEX CONCURRENTLY "SubscriptionCommand_shop_idempotency_nonnull_uq"
  ON "SubscriptionCommand" ("shop", "idempotencyKeyHash")
  WHERE "idempotencyKeyHash" IS NOT NULL;
