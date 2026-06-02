-- Phase H: Typed MetafieldMirror columns + indexes
ALTER TABLE "MetafieldMirror" ADD COLUMN IF NOT EXISTS "valueTextNormalized" TEXT;
ALTER TABLE "MetafieldMirror" ADD COLUMN IF NOT EXISTS "valueNumber" DECIMAL(30,10);
ALTER TABLE "MetafieldMirror" ADD COLUMN IF NOT EXISTS "valueBoolean" BOOLEAN;
ALTER TABLE "MetafieldMirror" ADD COLUMN IF NOT EXISTS "valueDate" TIMESTAMP(3);

UPDATE "MetafieldMirror"
SET "valueTextNormalized" = LOWER(BTRIM("valueText"))
WHERE "valueText" IS NOT NULL
  AND ("valueTextNormalized" IS NULL OR "valueTextNormalized" = '');

UPDATE "MetafieldMirror"
SET "valueNumber" = CASE
  WHEN "valueType" IN ('number_integer','number_decimal','rating','money')
       AND "valueText" ~ '^\\s*[+-]?([0-9]+(\\.[0-9]+)?|\\.[0-9]+)\\s*$'
    THEN BTRIM("valueText")::DECIMAL(30,10)
  ELSE "valueNumber"
END
WHERE "valueNumber" IS NULL;

UPDATE "MetafieldMirror"
SET "valueBoolean" = CASE
  WHEN LOWER(BTRIM("valueText")) = 'true' THEN TRUE
  WHEN LOWER(BTRIM("valueText")) = 'false' THEN FALSE
  ELSE "valueBoolean"
END
WHERE "valueBoolean" IS NULL;

UPDATE "MetafieldMirror"
SET "valueDate" = CASE
  WHEN "valueType" IN ('date','date_time')
       AND BTRIM(COALESCE("valueText", '')) <> ''
    THEN BTRIM("valueText")::TIMESTAMP
  ELSE "valueDate"
END
WHERE "valueDate" IS NULL;

CREATE INDEX IF NOT EXISTS "MetafieldMirror_shop_mirrorBatchId_ownerType_namespace_key_idx"
ON "MetafieldMirror"("shop", "mirrorBatchId", "ownerType", "namespace", "key");

CREATE INDEX IF NOT EXISTS "MetafieldMirror_shop_mirrorBatchId_namespace_key_valueTextNormalized_idx"
ON "MetafieldMirror"("shop", "mirrorBatchId", "namespace", "key", "valueTextNormalized");

CREATE INDEX IF NOT EXISTS "MetafieldMirror_shop_mirrorBatchId_namespace_key_valueNumber_idx"
ON "MetafieldMirror"("shop", "mirrorBatchId", "namespace", "key", "valueNumber");

CREATE INDEX IF NOT EXISTS "MetafieldMirror_shop_mirrorBatchId_namespace_key_valueBoolean_idx"
ON "MetafieldMirror"("shop", "mirrorBatchId", "namespace", "key", "valueBoolean");

CREATE INDEX IF NOT EXISTS "MetafieldMirror_shop_mirrorBatchId_namespace_key_valueDate_idx"
ON "MetafieldMirror"("shop", "mirrorBatchId", "namespace", "key", "valueDate");
