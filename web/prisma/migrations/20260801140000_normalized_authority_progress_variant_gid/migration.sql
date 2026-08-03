-- Normalized workflow columns become the sole writable lifecycle authority.
-- Preserve detected mismatches for audit before applying the explicit mapping.
CREATE TABLE IF NOT EXISTS "LegacyStateMismatchAudit" (
  "id" bigserial PRIMARY KEY,
  "modelName" varchar(64) NOT NULL,
  "recordId" text NOT NULL,
  "shop" text,
  "legacyField" varchar(64) NOT NULL,
  "legacyValue" text,
  "normalizedValue" text,
  "detectedAt" timestamptz NOT NULL DEFAULT now()
);

INSERT INTO "LegacyStateMismatchAudit"
  ("modelName", "recordId", "shop", "legacyField", "legacyValue", "normalizedValue")
SELECT 'EditHistory', "id", "shop", 'executionState', "executionState", "executionStateNormalized"::text
FROM "EditHistory"
WHERE upper(coalesce("executionState", '')) <> upper(coalesce("executionStateNormalized"::text, ''));

INSERT INTO "LegacyStateMismatchAudit"
  ("modelName", "recordId", "shop", "legacyField", "legacyValue", "normalizedValue")
SELECT 'EditHistory', "id", "shop", 'status', "status", "statusNormalized"::text
FROM "EditHistory"
WHERE upper(coalesce("status", '')) <> upper(coalesce("statusNormalized"::text, ''));

INSERT INTO "LegacyStateMismatchAudit"
  ("modelName", "recordId", "shop", "legacyField", "legacyValue", "normalizedValue")
SELECT 'WebhookDelivery', "id", "shop", 'status', "status", "statusNormalized"::text
FROM "WebhookDelivery"
WHERE upper(coalesce("status", '')) <> upper(coalesce("statusNormalized"::text, ''));

INSERT INTO "LegacyStateMismatchAudit"
  ("modelName", "recordId", "shop", "legacyField", "legacyValue", "normalizedValue")
SELECT 'OutboxEvent', "id", "shop", 'status', "status", "statusNormalized"::text
FROM "OutboxEvent"
WHERE upper(coalesce("status", '')) <> upper(coalesce("statusNormalized"::text, ''));

INSERT INTO "LegacyStateMismatchAudit"
  ("modelName", "recordId", "shop", "legacyField", "legacyValue", "normalizedValue")
SELECT 'ExportJob', "id", "shop", 'executionState', "executionState", "executionStateNormalized"::text
FROM "ExportJob"
WHERE upper(coalesce("executionState", '')) <> upper(coalesce("executionStateNormalized"::text, ''));

INSERT INTO "LegacyStateMismatchAudit"
  ("modelName", "recordId", "shop", "legacyField", "legacyValue", "normalizedValue")
SELECT 'ExportJob', "id", "shop", 'status', "status", "statusNormalized"::text
FROM "ExportJob"
WHERE upper(coalesce("status", '')) <> upper(coalesce("statusNormalized"::text, ''));

-- Recreate execution enums so normalized state retains the exact workflow stage.
ALTER TABLE "EditHistory" ALTER COLUMN "executionStateNormalized" DROP DEFAULT;
ALTER TYPE "EditHistoryExecutionState" RENAME TO "EditHistoryExecutionState_legacy";
CREATE TYPE "EditHistoryExecutionState" AS ENUM (
  'DRAFT','PREVIEWED','TARGET_FREEZING','TARGET_FROZEN','PLANNING',
  'SCHEDULED_PENDING_QUEUE','SCHEDULED_QUEUED','PLANNED','QUEUED','PAUSED',
  'WAITING_FOR_SHOPIFY_SLOT','EXECUTING','RECONCILE_SUBMITTED',
  'SHOPIFY_BULK_SUBMITTED','SHOPIFY_RUNNING','SHOPIFY_COMPLETED',
  'INGESTING_RESULTS','VERIFYING','MIRROR_UPDATING','UNDO_QUEUED','UNDO_RUNNING',
  'UNDO_COMPLETED','DISPATCHING','AWAITING_SHOPIFY','FINALIZING','COMPLETED',
  'FAILED','PARTIAL','PARTIAL_FAILED','CANCELLED','UNKNOWN'
);
ALTER TABLE "EditHistory" ALTER COLUMN "executionStateNormalized" TYPE "EditHistoryExecutionState"
USING (
  CASE
    WHEN upper("executionState") IN (
      'DRAFT','PREVIEWED','TARGET_FREEZING','TARGET_FROZEN','PLANNING',
      'SCHEDULED_PENDING_QUEUE','SCHEDULED_QUEUED','PLANNED','QUEUED','PAUSED',
      'WAITING_FOR_SHOPIFY_SLOT','EXECUTING','RECONCILE_SUBMITTED',
      'SHOPIFY_BULK_SUBMITTED','SHOPIFY_RUNNING','SHOPIFY_COMPLETED',
      'INGESTING_RESULTS','VERIFYING','MIRROR_UPDATING','UNDO_QUEUED','UNDO_RUNNING',
      'UNDO_COMPLETED','COMPLETED','FAILED','PARTIAL','PARTIAL_FAILED','CANCELLED'
    ) THEN upper("executionState")
    WHEN upper("executionState") = 'PARTIAL_FAILED' THEN 'PARTIAL'
    WHEN upper("executionState") = 'TARGETING_STARTED' THEN 'TARGET_FREEZING'
    WHEN upper("executionState") = 'TARGETING_FROZEN' THEN 'TARGET_FROZEN'
    WHEN upper("executionState") = 'QUEUED_FOR_EXECUTION' THEN 'QUEUED'
    ELSE 'UNKNOWN'
  END
)::"EditHistoryExecutionState";
ALTER TABLE "EditHistory" ALTER COLUMN "executionStateNormalized" SET DEFAULT 'PLANNED';
DROP TYPE "EditHistoryExecutionState_legacy";

ALTER TABLE "EditHistory" ALTER COLUMN "statusNormalized" DROP DEFAULT;
ALTER TYPE "EditHistoryStatus" RENAME TO "EditHistoryStatus_legacy";
CREATE TYPE "EditHistoryStatus" AS ENUM
  ('PENDING','PROCESSING','COMPLETED','FAILED','PARTIAL','UNDO_PENDING','CANCELLED','UNKNOWN');
ALTER TABLE "EditHistory" ALTER COLUMN "statusNormalized" TYPE "EditHistoryStatus"
USING (
  CASE
    WHEN upper("status") IN ('PENDING','PROCESSING','COMPLETED','FAILED','PARTIAL','UNDO_PENDING','CANCELLED')
      THEN upper("status")
    ELSE 'UNKNOWN'
  END
)::"EditHistoryStatus";
ALTER TABLE "EditHistory" ALTER COLUMN "statusNormalized" SET DEFAULT 'PENDING';
DROP TYPE "EditHistoryStatus_legacy";

ALTER TABLE "ExportJob" ALTER COLUMN "executionStateNormalized" DROP DEFAULT;
ALTER TYPE "ExportJobExecutionState" RENAME TO "ExportJobExecutionState_legacy";
CREATE TYPE "ExportJobExecutionState" AS ENUM
  ('PLANNED','QUEUED','PAUSED','RUNNING','FINALIZING','COMPLETED','FAILED','CANCELLED','UNKNOWN');
ALTER TABLE "ExportJob" ALTER COLUMN "executionStateNormalized" TYPE "ExportJobExecutionState"
USING (
  CASE
    WHEN upper("executionState") IN ('PLANNED','QUEUED','PAUSED','RUNNING','FINALIZING','COMPLETED','FAILED','CANCELLED')
      THEN upper("executionState")
    ELSE 'UNKNOWN'
  END
)::"ExportJobExecutionState";
ALTER TABLE "ExportJob" ALTER COLUMN "executionStateNormalized" SET DEFAULT 'PLANNED';
DROP TYPE "ExportJobExecutionState_legacy";

UPDATE "ExportJob"
SET "statusNormalized" = (
  CASE WHEN upper("status") IN ('PENDING','PROCESSING','COMPLETED','FAILED','CANCELLED')
    THEN upper("status") ELSE 'UNKNOWN' END
)::"ExportJobStatus";

UPDATE "WebhookDelivery"
SET "statusNormalized" = (
  CASE WHEN upper("status") IN ('RECEIVED','QUEUED','PROCESSING','PROCESSED','FAILED','IGNORED')
    THEN upper("status") ELSE 'UNKNOWN' END
)::"WebhookDeliveryStatus";

-- The payload immutability triggers share one function across tables with
-- different row shapes. Resolve fields through JSONB so a branch never asks a
-- generic record for a column that does not exist on the current trigger table.
CREATE OR REPLACE FUNCTION prevent_immutable_payload_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  new_row jsonb := to_jsonb(NEW);
  old_row jsonb := to_jsonb(OLD);
BEGIN
  IF TG_TABLE_NAME = 'OperationEnqueueIntent' AND
    jsonb_build_array(new_row->'payload', new_row->'payloadHash', new_row->'payloadByteSize', new_row->'payloadSchemaVersion', new_row->'payloadCompression', new_row->'payloadStorageKey') IS DISTINCT FROM
    jsonb_build_array(old_row->'payload', old_row->'payloadHash', old_row->'payloadByteSize', old_row->'payloadSchemaVersion', old_row->'payloadCompression', old_row->'payloadStorageKey') THEN
    RAISE EXCEPTION 'IMMUTABLE_OPERATION_ENQUEUE_PAYLOAD';
  ELSIF TG_TABLE_NAME = 'OutboxEvent' AND
    jsonb_build_array(new_row->'payloadJson', new_row->'payloadHash', new_row->'payloadByteSize', new_row->'payloadSchemaVersion', new_row->'payloadCompression', new_row->'payloadStorageKey') IS DISTINCT FROM
    jsonb_build_array(old_row->'payloadJson', old_row->'payloadHash', old_row->'payloadByteSize', old_row->'payloadSchemaVersion', old_row->'payloadCompression', old_row->'payloadStorageKey') THEN
    RAISE EXCEPTION 'IMMUTABLE_OUTBOX_PAYLOAD';
  ELSIF TG_TABLE_NAME = 'UndoCommand' AND
    jsonb_build_array(new_row->'commandJson', new_row->'commandHash', new_row->'payloadByteSize', new_row->'payloadSchemaVersion', new_row->'payloadCompression', new_row->'payloadStorageKey') IS DISTINCT FROM
    jsonb_build_array(old_row->'commandJson', old_row->'commandHash', old_row->'payloadByteSize', old_row->'payloadSchemaVersion', old_row->'payloadCompression', old_row->'payloadStorageKey') THEN
    RAISE EXCEPTION 'IMMUTABLE_UNDO_COMMAND_PAYLOAD';
  ELSIF TG_TABLE_NAME = 'UndoOperationConflictChunk' AND
    jsonb_build_array(new_row->'payload', new_row->'payloadHash', new_row->'payloadByteSize', new_row->'payloadSchemaVersion', new_row->'payloadCompression', new_row->'payloadStorageKey') IS DISTINCT FROM
    jsonb_build_array(old_row->'payload', old_row->'payloadHash', old_row->'payloadByteSize', old_row->'payloadSchemaVersion', old_row->'payloadCompression', old_row->'payloadStorageKey') THEN
    RAISE EXCEPTION 'IMMUTABLE_UNDO_CONFLICT_PAYLOAD';
  ELSIF TG_TABLE_NAME = 'TargetFreezeCommand' AND
    jsonb_build_array(new_row->'shop', new_row->'operationId', new_row->'sourceType', new_row->'sourceId', new_row->'sourceRevision', new_row->'configFingerprint', new_row->'mirrorBatchId', new_row->'targetMode', new_row->'filterAstJson', new_row->'savedTargetSetId', new_row->'editOperationJson', new_row->'payloadHash', new_row->'payloadByteSize', new_row->'payloadSchemaVersion', new_row->'payloadCompression', new_row->'payloadStorageKey') IS DISTINCT FROM
    jsonb_build_array(old_row->'shop', old_row->'operationId', old_row->'sourceType', old_row->'sourceId', old_row->'sourceRevision', old_row->'configFingerprint', old_row->'mirrorBatchId', old_row->'targetMode', old_row->'filterAstJson', old_row->'savedTargetSetId', old_row->'editOperationJson', old_row->'payloadHash', old_row->'payloadByteSize', old_row->'payloadSchemaVersion', old_row->'payloadCompression', old_row->'payloadStorageKey') THEN
    RAISE EXCEPTION 'IMMUTABLE_TARGET_FREEZE_COMMAND_PAYLOAD';
  END IF;
  RETURN NEW;
END $$;

UPDATE "OutboxEvent"
SET "statusNormalized" = (
  CASE WHEN upper("status") IN ('PENDING','DISPATCHING','DISPATCHED','DEAD_LETTER')
    THEN upper("status") ELSE 'PENDING' END
)::"OutboxEventStatus";

-- Compatibility columns are projections. Direct legacy writes are overwritten.
CREATE OR REPLACE FUNCTION project_normalized_workflow_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'EditHistory' THEN
    NEW."executionState" := lower(NEW."executionStateNormalized"::text);
    NEW."status" := lower(NEW."statusNormalized"::text);
  ELSIF TG_TABLE_NAME = 'ExportJob' THEN
    NEW."executionState" := lower(NEW."executionStateNormalized"::text);
    NEW."status" := NEW."statusNormalized"::text;
  ELSE
    NEW."status" := NEW."statusNormalized"::text;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "EditHistory_normalized_state_projection_trg" ON "EditHistory";
CREATE TRIGGER "EditHistory_normalized_state_projection_trg"
BEFORE INSERT OR UPDATE ON "EditHistory" FOR EACH ROW EXECUTE FUNCTION project_normalized_workflow_state();
DROP TRIGGER IF EXISTS "ExportJob_normalized_state_projection_trg" ON "ExportJob";
CREATE TRIGGER "ExportJob_normalized_state_projection_trg"
BEFORE INSERT OR UPDATE ON "ExportJob" FOR EACH ROW EXECUTE FUNCTION project_normalized_workflow_state();
DROP TRIGGER IF EXISTS "WebhookDelivery_normalized_state_projection_trg" ON "WebhookDelivery";
CREATE TRIGGER "WebhookDelivery_normalized_state_projection_trg"
BEFORE INSERT OR UPDATE ON "WebhookDelivery" FOR EACH ROW EXECUTE FUNCTION project_normalized_workflow_state();
DROP TRIGGER IF EXISTS "OutboxEvent_normalized_state_projection_trg" ON "OutboxEvent";
CREATE TRIGGER "OutboxEvent_normalized_state_projection_trg"
BEFORE INSERT OR UPDATE ON "OutboxEvent" FOR EACH ROW EXECUTE FUNCTION project_normalized_workflow_state();

-- Replace opaque counters with stable, named semantics. Unknown legacy stages are
-- retained and classified rather than guessed.
ALTER TABLE "OperationStageProgress"
  ADD COLUMN IF NOT EXISTS "succeededItemCount" integer,
  ADD COLUMN IF NOT EXISTS "failedItemCount" integer,
  ADD COLUMN IF NOT EXISTS "observedItemCount" integer;

UPDATE "OperationStageProgress"
SET "succeededItemCount" = "counterA",
    "failedItemCount" = "counterB",
    "observedItemCount" = "counterC"
WHERE "stageKey" IN ('RESULT_INGESTION', 'VERIFICATION');

CREATE TABLE IF NOT EXISTS "LegacyOperationStageCounterClassification" (
  "operationStageProgressId" text PRIMARY KEY,
  "stageKey" text NOT NULL,
  "classification" text NOT NULL DEFAULT 'SEMANTICS_UNVERIFIED',
  "classifiedAt" timestamptz NOT NULL DEFAULT now()
);
INSERT INTO "LegacyOperationStageCounterClassification" ("operationStageProgressId", "stageKey")
SELECT "id", "stageKey" FROM "OperationStageProgress"
WHERE "stageKey" NOT IN ('RESULT_INGESTION', 'VERIFICATION')
  AND ("counterA" IS NOT NULL OR "counterB" IS NOT NULL OR "counterC" IS NOT NULL)
ON CONFLICT ("operationStageProgressId") DO NOTHING;

ALTER TABLE "OperationStageProgress" ADD CONSTRAINT "OperationStageProgress_named_counts_nonnegative_ck"
CHECK (
  coalesce("succeededItemCount", 0) >= 0 AND
  coalesce("failedItemCount", 0) >= 0 AND
  coalesce("observedItemCount", 0) >= 0
) NOT VALID;
ALTER TABLE "OperationStageProgress" VALIDATE CONSTRAINT "OperationStageProgress_named_counts_nonnegative_ck";

-- Canonical variant identity. Verify the legacy bigint domain before deriving GIDs.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "variant_metafields" WHERE "variant_id" IS NULL OR "variant_id" <= 0) THEN
    RAISE EXCEPTION 'variant_metafields contains unverified legacy variant IDs';
  END IF;
END $$;

ALTER TABLE "variant_metafields" ADD COLUMN IF NOT EXISTS "variant_gid" varchar(255);
UPDATE "variant_metafields"
SET "variant_gid" = 'gid://shopify/ProductVariant/' || "variant_id"::text
WHERE "variant_gid" IS NULL;

ALTER TABLE "bulk_edit_changes" ADD COLUMN IF NOT EXISTS "variant_gid" varchar(255);
UPDATE "bulk_edit_changes" bec
SET "variant_gid" = vm."variant_gid"
FROM "variant_metafields" vm
WHERE vm."id" = bec."variant_metafield_id"
  AND vm."shop_id" = bec."shop_id"
  AND bec."variant_gid" IS NULL;

CREATE OR REPLACE FUNCTION sync_variant_gid_compatibility() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE legacy_text text;
BEGIN
  IF NEW."variant_gid" IS NULL AND NEW."variant_id" IS NOT NULL THEN
    IF NEW."variant_id" <= 0 THEN RAISE EXCEPTION 'legacy variant ID must be positive'; END IF;
    NEW."variant_gid" := 'gid://shopify/ProductVariant/' || NEW."variant_id"::text;
  ELSIF NEW."variant_gid" !~ '^gid://shopify/ProductVariant/[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'variant_gid must be a canonical ProductVariant GID';
  END IF;
  IF NEW."variant_id" IS NULL THEN
    legacy_text := substring(NEW."variant_gid" from '^gid://shopify/ProductVariant/([1-9][0-9]*)$');
    NEW."variant_id" := legacy_text::bigint;
  END IF;
  IF NEW."variant_gid" <> 'gid://shopify/ProductVariant/' || NEW."variant_id"::text THEN
    RAISE EXCEPTION 'variant_gid and legacy variant_id disagree';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "variant_metafields_gid_compatibility_trg" ON "variant_metafields";
CREATE TRIGGER "variant_metafields_gid_compatibility_trg"
BEFORE INSERT OR UPDATE OF "variant_gid", "variant_id" ON "variant_metafields"
FOR EACH ROW EXECUTE FUNCTION sync_variant_gid_compatibility();

ALTER TABLE "variant_metafields" ALTER COLUMN "variant_gid" SET NOT NULL;
ALTER TABLE "variant_metafields" ADD CONSTRAINT "variant_metafields_variant_gid_ck"
CHECK ("variant_gid" ~ '^gid://shopify/ProductVariant/[1-9][0-9]*$') NOT VALID;
ALTER TABLE "variant_metafields" VALIDATE CONSTRAINT "variant_metafields_variant_gid_ck";
CREATE UNIQUE INDEX IF NOT EXISTS "variant_metafields_shop_id_variant_gid_namespace_key_key"
ON "variant_metafields" ("shop_id", "variant_gid", "namespace", "key");

-- The legacy ledger may not exist in installations that never enabled v1 bulk metafields.
DO $$
BEGIN
  IF to_regclass('public.bulk_edit_changes') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM "bulk_edit_changes" WHERE "variant_gid" IS NULL) THEN
      RAISE EXCEPTION 'bulk_edit_changes contains rows without reconstructable variant GIDs';
    END IF;
    EXECUTE 'ALTER TABLE "bulk_edit_changes" ALTER COLUMN "variant_gid" SET NOT NULL';
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'bulk_edit_changes' AND column_name = 'namespace'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'bulk_edit_changes' AND column_name = 'key'
    ) THEN
      EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "bulk_edit_changes_session_variant_gid_namespace_key_uq"
        ON "bulk_edit_changes" ("session_id", "variant_gid", "namespace", "key")';
    END IF;
  END IF;
END $$;

-- Old identity indexes remain for the version-gated drain only. Remove them in
-- the later column-removal migration after no v1 queue/dead-letter rows remain.
