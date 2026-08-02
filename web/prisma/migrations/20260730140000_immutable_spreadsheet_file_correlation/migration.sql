-- Create shop-scoped unique indexes on SpreadsheetFile
CREATE UNIQUE INDEX IF NOT EXISTS "SpreadsheetFile_shop_id_uq"
ON "SpreadsheetFile" ("shop", "id");

CREATE UNIQUE INDEX IF NOT EXISTS "SpreadsheetFile_shop_checksum_id_uq"
ON "SpreadsheetFile" ("shop", "checksum", "id");

-- Add columns for storage key, byte size, previewed timestamp, and execution claim timestamp
ALTER TABLE "SpreadsheetFile" ADD COLUMN IF NOT EXISTS "storageKey" TEXT DEFAULT '';
ALTER TABLE "SpreadsheetFile" ADD COLUMN IF NOT EXISTS "sizeBytes" BIGINT DEFAULT 0;
ALTER TABLE "SpreadsheetFile" ADD COLUMN IF NOT EXISTS "previewedAt" TIMESTAMP(3);
ALTER TABLE "SpreadsheetFile" ADD COLUMN IF NOT EXISTS "executionClaimedAt" TIMESTAMP(3);
