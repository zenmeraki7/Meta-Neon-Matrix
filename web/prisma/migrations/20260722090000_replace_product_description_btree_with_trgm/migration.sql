-- Kept transaction-safe so Prisma Migrate can replay it in the shadow database.
-- Tenant and active-batch predicates continue to use Product_shop_mirrorBatchId_idx;
-- PostgreSQL can bitmap-combine it with this trigram index for substring searches.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

DROP INDEX IF EXISTS "Product_shop_mirrorBatchId_descriptionText_idx";

CREATE INDEX IF NOT EXISTS "product_active_description_trgm_idx"
  ON "Product"
  USING GIN ("descriptionText" gin_trgm_ops);
