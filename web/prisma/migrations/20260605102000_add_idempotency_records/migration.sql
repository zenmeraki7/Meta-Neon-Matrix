CREATE TABLE IF NOT EXISTS "IdempotencyRecord" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "response" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "IdempotencyRecord_shop_scope_key_key"
  ON "IdempotencyRecord" ("shop", "scope", "key");

CREATE INDEX IF NOT EXISTS "IdempotencyRecord_shop_idx"
  ON "IdempotencyRecord" ("shop");

CREATE INDEX IF NOT EXISTS "IdempotencyRecord_shop_state_expiresAt_idx"
  ON "IdempotencyRecord" ("shop", "state", "expiresAt");

CREATE INDEX IF NOT EXISTS "IdempotencyRecord_expiresAt_idx"
  ON "IdempotencyRecord" ("expiresAt");
