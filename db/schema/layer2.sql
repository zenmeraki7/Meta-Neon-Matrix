ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS active_mirror_batch_id UUID,
  ADD COLUMN IF NOT EXISTS mirror_product_count    INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS mirror_batches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'BUILDING'
                CHECK (status IN ('BUILDING','ACTIVE','SUPERSEDED','FAILED')),
  source      TEXT NOT NULL
                CHECK (source IN ('FULL_SYNC','RECONCILIATION')),
  product_count  INT NOT NULL DEFAULT 0,
  variant_count  INT NOT NULL DEFAULT 0,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ,
  job_id      UUID REFERENCES sync_jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_mirror_batches_shop
  ON mirror_batches (shop_id, status);

CREATE TABLE IF NOT EXISTS products (
  id                  BIGINT NOT NULL,
  shop_id             TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  mirror_batch_id     UUID REFERENCES mirror_batches(id),
  title               TEXT NOT NULL,
  handle              TEXT NOT NULL,
  status              TEXT NOT NULL,
  vendor              TEXT,
  product_type        TEXT,
  tags                JSONB NOT NULL DEFAULT '[]',
  shopify_created_at  TIMESTAMPTZ,
  shopify_updated_at  TIMESTAMPTZ,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_deleted          BOOLEAN NOT NULL DEFAULT false,
  deleted_at          TIMESTAMPTZ,
  delete_source       TEXT,
  PRIMARY KEY (id, shop_id)
);

CREATE INDEX IF NOT EXISTS idx_products_shop_active
  ON products (shop_id, shopify_updated_at DESC)
  WHERE is_deleted = false;

CREATE TABLE IF NOT EXISTS variants (
  id                  BIGINT NOT NULL,
  shop_id             TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  product_id          BIGINT NOT NULL,
  mirror_batch_id     UUID REFERENCES mirror_batches(id),
  title               TEXT NOT NULL,
  sku                 TEXT,
  price               TEXT NOT NULL,
  inventory_quantity  INT NOT NULL DEFAULT 0,
  position            INT NOT NULL DEFAULT 0,
  option_values       JSONB NOT NULL DEFAULT '[]',
  shopify_created_at  TIMESTAMPTZ,
  shopify_updated_at  TIMESTAMPTZ,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_deleted          BOOLEAN NOT NULL DEFAULT false,
  deleted_at          TIMESTAMPTZ,
  delete_source       TEXT,
  PRIMARY KEY (id, shop_id),
  FOREIGN KEY (product_id, shop_id) REFERENCES products(id, shop_id)
);

CREATE INDEX IF NOT EXISTS idx_variants_shop_product_active
  ON variants (shop_id, product_id)
  WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS idx_variants_shop_sku
  ON variants (shop_id, sku)
  WHERE sku IS NOT NULL AND is_deleted = false;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  shopify_delivery_id  TEXT NOT NULL,
  shop_id              TEXT NOT NULL,
  topic                TEXT NOT NULL,
  received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (shopify_delivery_id, shop_id)
);

CREATE TABLE IF NOT EXISTS product_sync_jobs (
  shop_id     TEXT NOT NULL,
  product_id  BIGINT NOT NULL,
  job_id      UUID NOT NULL REFERENCES sync_jobs(id),
  coalesced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, product_id)
);

