-- Neon/PostgreSQL: this migration uses CONCURRENTLY and must not be wrapped in a transaction.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ErrorLog_shop_createdAt_idx"
  ON "ErrorLog" ("shop", "createdAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ErrorLog_shop_level_createdAt_idx"
  ON "ErrorLog" ("shop", "level", "createdAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ErrorLog_shop_type_createdAt_idx"
  ON "ErrorLog" ("shop", "type", "createdAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ErrorLog_level_createdAt_idx"
  ON "ErrorLog" ("level", "createdAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "FilterTrack_shop_expiresAt_idx"
  ON "FilterTrack" ("shop", "expiresAt");

DROP INDEX CONCURRENTLY IF EXISTS "ErrorLog_shop_idx";
DROP INDEX CONCURRENTLY IF EXISTS "ErrorLog_type_idx";
DROP INDEX CONCURRENTLY IF EXISTS "ErrorLog_level_idx";
DROP INDEX CONCURRENTLY IF EXISTS "ErrorLog_source_idx";
DROP INDEX CONCURRENTLY IF EXISTS "ErrorLog_createdAt_idx";
DROP INDEX CONCURRENTLY IF EXISTS "FilterTrack_shop_idx";
