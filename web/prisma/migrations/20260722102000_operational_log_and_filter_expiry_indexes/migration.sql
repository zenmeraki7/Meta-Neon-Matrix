-- Kept transaction-safe so Prisma Migrate can replay it in the shadow database.

CREATE INDEX IF NOT EXISTS "ErrorLog_shop_createdAt_idx"
  ON "ErrorLog" ("shop", "createdAt");
CREATE INDEX IF NOT EXISTS "ErrorLog_shop_level_createdAt_idx"
  ON "ErrorLog" ("shop", "level", "createdAt");
CREATE INDEX IF NOT EXISTS "ErrorLog_shop_type_createdAt_idx"
  ON "ErrorLog" ("shop", "type", "createdAt");
CREATE INDEX IF NOT EXISTS "ErrorLog_level_createdAt_idx"
  ON "ErrorLog" ("level", "createdAt");

CREATE INDEX IF NOT EXISTS "FilterTrack_shop_expiresAt_idx"
  ON "FilterTrack" ("shop", "expiresAt");

DROP INDEX IF EXISTS "ErrorLog_shop_idx";
DROP INDEX IF EXISTS "ErrorLog_type_idx";
DROP INDEX IF EXISTS "ErrorLog_level_idx";
DROP INDEX IF EXISTS "ErrorLog_source_idx";
DROP INDEX IF EXISTS "ErrorLog_createdAt_idx";
DROP INDEX IF EXISTS "FilterTrack_shop_idx";
