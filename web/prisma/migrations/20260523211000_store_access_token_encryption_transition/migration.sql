ALTER TABLE "Store"
  ADD COLUMN IF NOT EXISTS "accessTokenEncrypted" TEXT,
  ADD COLUMN IF NOT EXISTS "accessTokenKeyVersion" TEXT;

CREATE INDEX IF NOT EXISTS "Store_accessTokenKeyVersion_idx"
  ON "Store"("accessTokenKeyVersion");
