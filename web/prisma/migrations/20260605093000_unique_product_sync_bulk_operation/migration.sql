CREATE UNIQUE INDEX IF NOT EXISTS "SyncHistory_shop_bulkOperationId_operationType_unique"
ON "SyncHistory" ("shop", "bulkOperationId", "operationType")
WHERE "bulkOperationId" IS NOT NULL;
