ALTER TABLE variant_metafields
ADD COLUMN IF NOT EXISTS shopify_version bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS dead_letter_changes (
  id uuid PRIMARY KEY,
  original_change jsonb NOT NULL,
  error_code text NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now(),
  shop_id text NOT NULL,
  notified boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS dead_letter_changes_shop_failed_idx
ON dead_letter_changes (shop_id, failed_at DESC);

CREATE INDEX IF NOT EXISTS dead_letter_changes_notified_idx
ON dead_letter_changes (notified);
