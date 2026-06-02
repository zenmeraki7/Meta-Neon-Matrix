ALTER TABLE "TargetSnapshot"
ADD COLUMN IF NOT EXISTS "source" TEXT;

CREATE INDEX IF NOT EXISTS "TargetSnapshot_shop_ownerType_source_createdAt_idx"
ON "TargetSnapshot"("shop", "ownerType", "source", "createdAt");
