-- Retire compatibility storage only after proving the authoritative forms exist.
-- This migration intentionally fails closed rather than discarding plaintext-only
-- credentials or a tenant table that still owns foreign keys.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Store"
    WHERE "accessToken" IS NOT NULL
      AND "accessTokenEncrypted" IS NULL
  ) THEN
    RAISE EXCEPTION
      'Store contains plaintext-only access tokens; encrypt and clear them before this migration';
  END IF;

  IF to_regclass('public.shops') IS NOT NULL AND EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE contype = 'f'
      AND confrelid = to_regclass('public.shops')
  ) THEN
    RAISE EXCEPTION
      'Legacy shops table still has foreign-key dependents; migrate them to Store.shopUrl first';
  END IF;
END $$;

DROP INDEX CONCURRENTLY IF EXISTS "Store_isUnInstalled_idx";

ALTER TABLE "Store"
  DROP COLUMN IF EXISTS "accessToken",
  DROP COLUMN IF EXISTS "isUnInstalled";

ALTER TABLE "AutomaticProductRule"
  DROP COLUMN IF EXISTS "isDeleted";

DROP TABLE IF EXISTS "shops";
