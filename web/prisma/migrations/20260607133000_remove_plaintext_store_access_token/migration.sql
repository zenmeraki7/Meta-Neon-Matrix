DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Store"
    WHERE "accessToken" IS NOT NULL
      AND "accessTokenEncrypted" IS NULL
  ) THEN
    RAISE EXCEPTION 'PLAINTEXT_ACCESS_TOKEN_REMAINS: encrypt Store.accessToken before dropping plaintext column';
  END IF;
END $$;

ALTER TABLE "Store"
  DROP COLUMN IF EXISTS "accessToken";
