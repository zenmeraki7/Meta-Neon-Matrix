-- Ensure base table exists before adding shopify_version.
-- This is required because Prisma shadow DB says variant_metafields does not exist.

CREATE TABLE IF NOT EXISTS "shops" (
  "id" TEXT NOT NULL,
  "shopify_domain" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "plan" TEXT NOT NULL DEFAULT 'free',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "uninstalled_at" TIMESTAMP(3),
  "last_synced_at" TIMESTAMP(3),

  CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "shops_shopify_domain_key"
ON "shops"("shopify_domain");


CREATE TABLE IF NOT EXISTS "variant_metafields" (
  "id" BIGSERIAL NOT NULL,
  "shop_id" TEXT NOT NULL,
  "variant_id" BIGINT NOT NULL,
  "shopify_metafield_id" TEXT,
  "namespace" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "type" TEXT,
  "value" TEXT,
  "pending_value" TEXT,
  "compare_digest" TEXT,
  "shopify_version" BIGINT NOT NULL DEFAULT 0,
  "edit_status" TEXT NOT NULL DEFAULT 'SYNCED',
  "is_dirty" BOOLEAN NOT NULL DEFAULT false,
  "last_edited_at" TIMESTAMP(3),
  "last_synced_at" TIMESTAMP(3),

  CONSTRAINT "variant_metafields_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "variant_metafields"
ADD COLUMN IF NOT EXISTS "shopify_version" BIGINT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'variant_metafields_shop_id_fkey'
  ) THEN
    ALTER TABLE "variant_metafields"
    ADD CONSTRAINT "variant_metafields_shop_id_fkey"
    FOREIGN KEY ("shop_id")
    REFERENCES "shops"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "variant_metafields_variant_key_idx"
ON "variant_metafields"("variant_id", "namespace", "key");

CREATE INDEX IF NOT EXISTS "variant_metafields_shop_dirty_idx"
ON "variant_metafields"("shop_id", "is_dirty");

CREATE UNIQUE INDEX IF NOT EXISTS "variant_metafields_shop_variant_namespace_key"
ON "variant_metafields"("shop_id", "variant_id", "namespace", "key");


CREATE TABLE IF NOT EXISTS "dead_letter_changes" (
  "id" UUID NOT NULL,
  "original_change" JSONB NOT NULL,
  "error_code" TEXT NOT NULL,
  "failed_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "shop_id" TEXT NOT NULL,
  "notified" BOOLEAN NOT NULL DEFAULT false,

  CONSTRAINT "dead_letter_changes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "dead_letter_changes_shop_failed_idx"
ON "dead_letter_changes"("shop_id", "failed_at" DESC);

CREATE INDEX IF NOT EXISTS "dead_letter_changes_notified_idx"
ON "dead_letter_changes"("notified");