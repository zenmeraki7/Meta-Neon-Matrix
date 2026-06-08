DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'variant_metafields'
  ) THEN
    ALTER TABLE "variant_metafields"
    ADD COLUMN IF NOT EXISTS "shopify_version" BIGINT NOT NULL DEFAULT 0;
  END IF;
END $$;


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