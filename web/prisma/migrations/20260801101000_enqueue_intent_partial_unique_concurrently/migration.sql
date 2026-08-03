CREATE UNIQUE INDEX "OperationEnqueueIntent_shop_scope_dedupe_nonnull_uq"
ON "OperationEnqueueIntent" ("shop", "dispatchScope", "dedupeKey")
WHERE "dedupeKey" IS NOT NULL;

