UPDATE "Store"
SET "shopEmail" = NULL
WHERE "shopEmail" = '';

ALTER TABLE "Store"
  ALTER COLUMN "shopEmail" DROP NOT NULL;
