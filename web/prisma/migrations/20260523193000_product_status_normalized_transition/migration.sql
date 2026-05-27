DO $$
BEGIN
  CREATE TYPE "ShopifyProductStatus" AS ENUM ('ACTIVE', 'DRAFT', 'ARCHIVED', 'UNKNOWN');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "statusNormalized" "ShopifyProductStatus";

UPDATE "Product"
SET "statusNormalized" = CASE UPPER(COALESCE("status", ''))
  WHEN 'ACTIVE' THEN 'ACTIVE'::"ShopifyProductStatus"
  WHEN 'DRAFT' THEN 'DRAFT'::"ShopifyProductStatus"
  WHEN 'ARCHIVED' THEN 'ARCHIVED'::"ShopifyProductStatus"
  ELSE 'UNKNOWN'::"ShopifyProductStatus"
END
WHERE "statusNormalized" IS NULL;

ALTER TABLE "Product"
  ALTER COLUMN "statusNormalized" SET DEFAULT 'UNKNOWN'::"ShopifyProductStatus";

ALTER TABLE "Product"
  ALTER COLUMN "statusNormalized" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "Product_shop_statusNormalized_idx"
  ON "Product"("shop", "statusNormalized");

CREATE INDEX IF NOT EXISTS "Product_shop_mirrorBatchId_statusNormalized_idx"
  ON "Product"("shop", "mirrorBatchId", "statusNormalized");
