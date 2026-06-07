CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE "bulk_edit_changes"
  DROP CONSTRAINT IF EXISTS "bulk_edit_changes_session_id_fkey",
  DROP CONSTRAINT IF EXISTS "bulk_edit_changes_variant_metafield_id_fkey",
  DROP CONSTRAINT IF EXISTS "bulk_edit_changes_pkey";
ALTER TABLE "bulk_edit_sessions"
  DROP CONSTRAINT IF EXISTS "bulk_edit_sessions_shop_id_fkey",
  DROP CONSTRAINT IF EXISTS "bulk_edit_sessions_pkey";
DROP INDEX IF EXISTS "bulk_edit_changes_session_id_status_idx";
DROP INDEX IF EXISTS "bulk_edit_changes_session_id_variant_metafield_id_key";
DROP INDEX IF EXISTS "bulk_edit_changes_session_status_pending_idx";
DROP INDEX IF EXISTS "bulk_edit_changes_retryable_idx";
DROP INDEX IF EXISTS "bulk_edit_changes_stale_writing_idx";

ALTER TABLE "bulk_edit_changes" RENAME TO "bulk_edit_changes_legacy";
ALTER TABLE "bulk_edit_sessions" RENAME TO "bulk_edit_sessions_legacy";

CREATE TEMP TABLE "bulk_edit_session_id_map" (
  "legacy_id" BIGINT PRIMARY KEY,
  "canonical_id" UUID NOT NULL UNIQUE
) ON COMMIT DROP;

INSERT INTO "bulk_edit_session_id_map" ("legacy_id", "canonical_id")
SELECT "id", gen_random_uuid()
FROM "bulk_edit_sessions_legacy";

CREATE TABLE "bulk_edit_sessions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shop_id" TEXT NOT NULL,
  "status" "SessionStatus" NOT NULL DEFAULT 'DRAFT',
  "filter_params" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "variant_count" INTEGER NOT NULL DEFAULT 0,
  "change_count" INTEGER NOT NULL DEFAULT 0,
  "written_count" INTEGER NOT NULL DEFAULT 0,
  "error_count" INTEGER NOT NULL DEFAULT 0,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bulk_edit_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bulk_edit_sessions_shop_id_fkey"
    FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "bulk_edit_sessions" (
  "id", "shop_id", "status", "created_at", "updated_at"
)
SELECT
  map."canonical_id",
  legacy."shop_id",
  legacy."status",
  legacy."created_at",
  legacy."updated_at"
FROM "bulk_edit_sessions_legacy" legacy
JOIN "bulk_edit_session_id_map" map ON map."legacy_id" = legacy."id";

CREATE TABLE "bulk_edit_changes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "session_id" UUID NOT NULL,
  "shop_id" TEXT NOT NULL,
  "variant_id" BIGINT NOT NULL,
  "definition_id" UUID,
  "shopify_owner_id" TEXT NOT NULL,
  "field_name" TEXT NOT NULL,
  "namespace" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "type" TEXT,
  "old_value" TEXT,
  "new_value" TEXT,
  "compare_digest" TEXT,
  "status" "ChangeStatus" NOT NULL DEFAULT 'PENDING',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "shopify_error" TEXT,
  "retryable" BOOLEAN NOT NULL DEFAULT true,
  "writing_started_at" TIMESTAMPTZ,
  "applied_at" TIMESTAMPTZ,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bulk_edit_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bulk_edit_changes_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "bulk_edit_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "bulk_edit_changes_shop_id_fkey"
    FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "bulk_edit_changes" (
  "session_id",
  "shop_id",
  "variant_id",
  "shopify_owner_id",
  "field_name",
  "namespace",
  "key",
  "type",
  "old_value",
  "new_value",
  "compare_digest",
  "status",
  "retryable",
  "created_at",
  "updated_at"
)
SELECT
  map."canonical_id",
  vm."shop_id",
  vm."variant_id",
  'gid://shopify/ProductVariant/' || vm."variant_id"::text,
  vm."namespace" || '.' || vm."key",
  vm."namespace",
  vm."key",
  vm."type",
  vm."value",
  legacy."new_value",
  legacy."compare_digest",
  legacy."status",
  legacy."retryable",
  legacy."created_at",
  legacy."updated_at"
FROM "bulk_edit_changes_legacy" legacy
JOIN "bulk_edit_session_id_map" map ON map."legacy_id" = legacy."session_id"
JOIN "variant_metafields" vm ON vm."id" = legacy."variant_metafield_id";

CREATE UNIQUE INDEX "bulk_edit_changes_session_variant_field_key"
  ON "bulk_edit_changes"("session_id", "variant_id", "namespace", "key");
CREATE INDEX "bulk_edit_changes_shop_session_status_idx"
  ON "bulk_edit_changes"("shop_id", "session_id", "status");
CREATE INDEX "bulk_edit_changes_stale_writing_idx"
  ON "bulk_edit_changes"("shop_id", "status", "writing_started_at")
  WHERE "status" = 'WRITING';

DROP TABLE "bulk_edit_changes_legacy";
DROP TABLE "bulk_edit_sessions_legacy";
