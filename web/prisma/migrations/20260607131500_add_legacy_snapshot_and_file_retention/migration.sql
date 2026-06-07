ALTER TABLE "TargetSnapshot"
  ADD COLUMN IF NOT EXISTS "purgeAfter" TIMESTAMP(3) NOT NULL DEFAULT (now() + interval '7 days');

UPDATE "TargetSnapshot"
SET "purgeAfter" = COALESCE("purgeAfter", "createdAt" + interval '7 days');

ALTER TABLE "TargetSnapshot"
  ALTER COLUMN "purgeAfter" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "TargetSnapshot_shop_purgeAfter_idx"
  ON "TargetSnapshot"("shop", "purgeAfter");

ALTER TABLE "SpreadsheetFile"
  ADD COLUMN IF NOT EXISTS "storageExpiresAt" TIMESTAMP(3) NOT NULL DEFAULT (now() + interval '30 days');

UPDATE "SpreadsheetFile"
SET "storageExpiresAt" = COALESCE("storageExpiresAt", "createdAt" + interval '30 days');

ALTER TABLE "SpreadsheetFile"
  ALTER COLUMN "storageExpiresAt" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "SpreadsheetFile_shop_storageExpiresAt_idx"
  ON "SpreadsheetFile"("shop", "storageExpiresAt");

ALTER TABLE "ExportHistory"
  ADD COLUMN IF NOT EXISTS "storageExpiresAt" TIMESTAMP(3) NOT NULL DEFAULT (now() + interval '30 days');

UPDATE "ExportHistory"
SET "storageExpiresAt" = COALESCE("storageExpiresAt", COALESCE("exportTime", "createdAt") + interval '30 days');

ALTER TABLE "ExportHistory"
  ALTER COLUMN "storageExpiresAt" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "ExportHistory_shop_storageExpiresAt_idx"
  ON "ExportHistory"("shop", "storageExpiresAt");
