-- Optional trigram acceleration for variant text contains filters.
-- Kept transaction-safe for Prisma Migrate (no CONCURRENTLY).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "variant_sku_trgm_idx"
  ON "Variant"
  USING GIN ("sku" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "variant_barcode_trgm_idx"
  ON "Variant"
  USING GIN ("barcode" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "variant_option1_value_trgm_idx"
  ON "Variant"
  USING GIN ("option1Value" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "variant_option2_value_trgm_idx"
  ON "Variant"
  USING GIN ("option2Value" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "variant_option3_value_trgm_idx"
  ON "Variant"
  USING GIN ("option3Value" gin_trgm_ops);
