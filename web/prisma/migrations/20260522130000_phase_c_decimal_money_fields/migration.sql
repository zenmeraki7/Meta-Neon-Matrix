-- Phase C: money fields migrated from float/double precision to numeric
ALTER TABLE "Variant"
  ALTER COLUMN "price" TYPE DECIMAL(20,6) USING ROUND(("price")::numeric, 6),
  ALTER COLUMN "compareAtPrice" TYPE DECIMAL(20,6) USING ROUND(("compareAtPrice")::numeric, 6),
  ALTER COLUMN "cost" TYPE DECIMAL(20,6) USING ROUND(("cost")::numeric, 6);

ALTER TABLE "Store"
  ALTER COLUMN "refEarnedPrice" TYPE DECIMAL(20,6) USING ROUND(("refEarnedPrice")::numeric, 6),
  ALTER COLUMN "refEarnedPrice" SET DEFAULT 0;

ALTER TABLE "AffiliateUser"
  ALTER COLUMN "totalAmountEarned" TYPE DECIMAL(20,6) USING ROUND(("totalAmountEarned")::numeric, 6),
  ALTER COLUMN "totalAmountEarned" SET DEFAULT 0;