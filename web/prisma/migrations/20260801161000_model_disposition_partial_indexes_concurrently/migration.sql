-- This migration must run without a surrounding transaction.
CREATE UNIQUE INDEX "UndoOperation_shop_execution_nonnull_uq"
  ON "UndoOperation" ("shop", "executionId") WHERE "executionId" IS NOT NULL;

CREATE INDEX "ProductMediaMirror_reconcile_idx"
  ON "ProductMediaMirror" ("shop", "mirrorBatchId", "reconciliationCompletedAt", "mediaId")
  WHERE "isDeleted" = false;

CREATE INDEX "ProductCollection_reconcile_idx"
  ON "ProductCollection" ("shop", "mirrorBatchId", "reconciliationCompletedAt", "productId", "collectionId")
  WHERE "isDeleted" = false;

CREATE UNIQUE INDEX "SubscriptionCommand_shop_idempotency_nonnull_uq"
  ON "SubscriptionCommand" ("shop", "idempotencyKeyHash")
  WHERE "idempotencyKeyHash" IS NOT NULL;
