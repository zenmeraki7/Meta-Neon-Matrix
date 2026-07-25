-- Neon/PostgreSQL identity and session hardening.
-- CREATE INDEX CONCURRENTLY requires this migration to run without an outer transaction.

-- Build replacement indexes before taking the brief locks needed for constraint swaps.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "WebhookDelivery_shop_dedupeKey_key"
  ON "WebhookDelivery" ("shop", "dedupeKey");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "WebhookDelivery_shop_webhookId_idx"
  ON "WebhookDelivery" ("shop", "webhookId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "shopify_sessions_shop_idx"
  ON "shopify_sessions" ("shop");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "shopify_sessions_shop_isOnline_idx"
  ON "shopify_sessions" ("shop", "isOnline");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "shopify_sessions_shop_expires_idx"
  ON "shopify_sessions" ("shop", "expires");

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "MirrorReconcileSignal"
    GROUP BY "shop", "entityType", "entityId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'MirrorReconcileSignal contains duplicate natural identities';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "WebhookDelivery"
    GROUP BY "shop", "dedupeKey"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'WebhookDelivery contains duplicate tenant-scoped dedupe keys';
  END IF;
END $$;

ALTER TABLE "MirrorReconcileSignal" DROP CONSTRAINT "MirrorReconcileSignal_pkey";
ALTER TABLE "MirrorReconcileSignal" ADD CONSTRAINT "MirrorReconcileSignal_pkey"
  PRIMARY KEY USING INDEX "MirrorReconcileSignal_shop_entityType_entityId_key";
ALTER TABLE "MirrorReconcileSignal" DROP COLUMN "id";

-- Prisma's former @unique generated this globally-scoped standalone index.
DROP INDEX CONCURRENTLY IF EXISTS "WebhookDelivery_dedupeKey_key";

-- The Shopify PostgreSQL session adapter owns `expires` and `accessToken`.
-- `expiresAt` was an unused application duplicate and is safe to remove.
ALTER TABLE "shopify_sessions" DROP COLUMN IF EXISTS "expiresAt";

ALTER TABLE "Store" ALTER COLUMN "shopEmail" DROP NOT NULL;

-- Store.accessToken remains temporarily for rollback/backfill compatibility.
-- New writes clear it whenever encrypted storage succeeds; the existing
-- backfillAccessTokenEncryption.js script encrypts and clears legacy values.
