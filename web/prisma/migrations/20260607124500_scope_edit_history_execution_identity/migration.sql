DROP INDEX IF EXISTS "EditHistory_executionIdentity_key";
DROP INDEX IF EXISTS "EditHistory_shop_executionIdentity_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "EditHistory_shop_executionIdentity_key"
  ON "EditHistory"("shop", "executionIdentity");
