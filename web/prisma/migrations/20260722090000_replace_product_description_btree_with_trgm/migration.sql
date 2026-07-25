-- This migration uses CONCURRENTLY and must not be wrapped in a transaction.
-- Tenant and active-batch predicates continue to use Product_shop_mirrorBatchId_idx;
-- PostgreSQL can bitmap-combine it with this trigram index for substring searches.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

DROP INDEX CONCURRENTLY IF EXISTS "Product_shop_mirrorBatchId_descriptionText_idx";

CREATE INDEX CONCURRENTLY IF NOT EXISTS "product_active_description_trgm_idx"
  ON "Product"
  USING GIN ("descriptionText" gin_trgm_ops);
