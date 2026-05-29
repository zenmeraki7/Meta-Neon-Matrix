CREATE TABLE IF NOT EXISTS shops (
  id                TEXT PRIMARY KEY,
  shopify_domain    TEXT NOT NULL UNIQUE,
  scope             TEXT NOT NULL,
  plan              TEXT NOT NULL DEFAULT 'free',
  active            BOOLEAN NOT NULL DEFAULT true,
  installed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  uninstalled_at    TIMESTAMPTZ,
  last_synced_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  type              TEXT NOT NULL CHECK (type IN ('FULL_SYNC','INCREMENTAL_SYNC','BULK_WRITE')),
  status            TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','RUNNING','DONE','FAILED')),
  meta              JSONB NOT NULL DEFAULT '{}',
  total_count       INT NOT NULL DEFAULT 0,
  processed_count   INT NOT NULL DEFAULT 0,
  error_count       INT NOT NULL DEFAULT 0,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  error_message     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_shop_status
  ON sync_jobs (shop_id, status, created_at DESC);
