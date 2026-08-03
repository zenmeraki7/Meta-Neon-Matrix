CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Consolidate legacy duplicate schema declarations into the authoritative models.
ALTER TABLE "AutomaticProductRuleRun"
  ADD COLUMN IF NOT EXISTS "targetResourceTypeSnapshot" text;
ALTER TYPE "ScheduledExportRunStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "RecurringEditRunStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "RecurringEditRunStatus" ADD VALUE IF NOT EXISTS 'PARTIAL';

-- Preserve raw Shopify status while making the normalized projection extensible.
ALTER TABLE "Product" ALTER COLUMN "statusNormalized" DROP DEFAULT;
ALTER TABLE "Product" ALTER COLUMN "statusNormalized" TYPE varchar(32)
USING COALESCE("statusNormalized"::text, 'UNKNOWN');
ALTER TABLE "Product" ALTER COLUMN "statusNormalized" SET DEFAULT 'UNKNOWN';
ALTER TABLE "Product" ADD CONSTRAINT "Product_statusNormalized_known_ck"
CHECK ("statusNormalized" IN ('ACTIVE', 'DRAFT', 'ARCHIVED', 'UNKNOWN')) NOT VALID;
ALTER TABLE "Product" VALIDATE CONSTRAINT "Product_statusNormalized_known_ck";

-- Refuse to reduce monetary scale until the production data proves it is safe.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Variant" WHERE
    "price" IS DISTINCT FROM round("price", 4) OR
    "compareAtPrice" IS DISTINCT FROM round("compareAtPrice", 4) OR
    "cost" IS DISTINCT FROM round("cost", 4)) THEN
    RAISE EXCEPTION 'MONEY_SCALE_OUTLIERS_PRESENT_IN_VARIANT';
  END IF;
  IF EXISTS (SELECT 1 FROM "Store" WHERE "refEarnedPrice" IS DISTINCT FROM round("refEarnedPrice", 4)) THEN
    RAISE EXCEPTION 'MONEY_SCALE_OUTLIERS_PRESENT_IN_STORE';
  END IF;
  IF EXISTS (SELECT 1 FROM "AffiliateUser" WHERE "totalAmountEarned" IS DISTINCT FROM round("totalAmountEarned", 4)) THEN
    RAISE EXCEPTION 'MONEY_SCALE_OUTLIERS_PRESENT_IN_USER';
  END IF;
  IF EXISTS (SELECT 1 FROM "InventoryItemMirror" WHERE "cost" IS DISTINCT FROM round("cost", 4)) THEN
    RAISE EXCEPTION 'MONEY_SCALE_OUTLIERS_PRESENT_IN_INVENTORY_ITEM';
  END IF;
END $$;

ALTER TABLE "Variant"
  ALTER COLUMN "price" TYPE numeric(20,4),
  ALTER COLUMN "compareAtPrice" TYPE numeric(20,4),
  ALTER COLUMN "cost" TYPE numeric(20,4),
  ADD COLUMN "profitMarginRatio" numeric(12,8);
UPDATE "Variant" SET "profitMarginRatio" = round("profitMargin" / 100, 8)
WHERE "profitMargin" IS NOT NULL;
ALTER TABLE "Variant" DROP COLUMN "profitMargin";
ALTER TABLE "Store" ALTER COLUMN "refEarnedPrice" TYPE numeric(20,4);
ALTER TABLE "AffiliateUser" ALTER COLUMN "totalAmountEarned" TYPE numeric(20,4);
ALTER TABLE "InventoryItemMirror" ALTER COLUMN "cost" TYPE numeric(20,4);

ALTER TABLE "Variant" ADD CONSTRAINT "Variant_money_nonnegative_ck" CHECK (
  ("price" IS NULL OR "price" >= 0) AND
  ("compareAtPrice" IS NULL OR "compareAtPrice" >= 0) AND
  ("cost" IS NULL OR "cost" >= 0)) NOT VALID;
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_profitMarginRatio_domain_ck"
CHECK ("profitMarginRatio" IS NULL OR "profitMarginRatio" BETWEEN -1000 AND 1) NOT VALID;
ALTER TABLE "Variant" VALIDATE CONSTRAINT "Variant_money_nonnegative_ck";
ALTER TABLE "Variant" VALIDATE CONSTRAINT "Variant_profitMarginRatio_domain_ck";
ALTER TABLE "Store" ADD CONSTRAINT "Store_refEarnedPrice_nonnegative_ck"
CHECK ("refEarnedPrice" >= 0) NOT VALID;
ALTER TABLE "AffiliateUser" ADD CONSTRAINT "AffiliateUser_totalAmountEarned_nonnegative_ck"
CHECK ("totalAmountEarned" >= 0) NOT VALID;
ALTER TABLE "InventoryItemMirror" ADD CONSTRAINT "InventoryItemMirror_cost_nonnegative_ck"
CHECK ("cost" IS NULL OR "cost" >= 0) NOT VALID;

-- Quarantine evidence without deleting or silently repairing historical identities.
CREATE TABLE "LegacyMalformedIdentity" (
  "tableName" text NOT NULL,
  "shop" text,
  "recordIdentity" text NOT NULL,
  "reason" text NOT NULL,
  "capturedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("tableName", "recordIdentity", "reason")
);
INSERT INTO "LegacyMalformedIdentity" ("tableName", "shop", "recordIdentity", "reason")
SELECT 'Product', "shop", "id", 'MALFORMED_SHOP_OR_PRODUCT_GID' FROM "Product"
WHERE "shop" !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$'
   OR "id" !~ '^gid://shopify/Product/[1-9][0-9]*$' ON CONFLICT DO NOTHING;
INSERT INTO "LegacyMalformedIdentity" ("tableName", "shop", "recordIdentity", "reason")
SELECT 'Variant', "shop", "id", 'MALFORMED_SHOP_OR_VARIANT_GID' FROM "Variant"
WHERE "shop" !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$'
   OR "id" !~ '^gid://shopify/ProductVariant/[1-9][0-9]*$' ON CONFLICT DO NOTHING;

ALTER TABLE "Product" ADD CONSTRAINT "Product_shop_domain_ck"
CHECK (length("shop") <= 255 AND "shop" ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$') NOT VALID;
ALTER TABLE "Product" ADD CONSTRAINT "Product_gid_ck"
CHECK (length("id") <= 255 AND "id" ~ '^gid://shopify/Product/[1-9][0-9]*$') NOT VALID;
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_shop_domain_ck"
CHECK (length("shop") <= 255 AND "shop" ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$') NOT VALID;
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_gid_ck"
CHECK (length("id") <= 255 AND "id" ~ '^gid://shopify/ProductVariant/[1-9][0-9]*$') NOT VALID;
ALTER TABLE "variant_metafields" ADD CONSTRAINT "VariantMetafield_namespace_key_length_ck"
CHECK (length("namespace") BETWEEN 1 AND 255 AND length("key") BETWEEN 1 AND 64) NOT VALID;
ALTER TABLE "MetafieldMirror" ADD CONSTRAINT "MetafieldMirror_namespace_key_length_ck"
CHECK (length("namespace") BETWEEN 1 AND 255 AND length("key") BETWEEN 1 AND 64) NOT VALID;

-- Metadata for immutable JSON commands/events. Existing JSONB is hashed using
-- the same recursively key-sorted, whitespace-free representation as new writes.
CREATE OR REPLACE FUNCTION canonical_jsonb_text(value jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE result text;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT '{' || COALESCE(string_agg(to_json(key)::text || ':' || canonical_jsonb_text(val), ',' ORDER BY key COLLATE "C"), '') || '}'
      INTO result FROM jsonb_each(value) AS item(key, val);
      RETURN result;
    WHEN 'array' THEN
      SELECT '[' || COALESCE(string_agg(canonical_jsonb_text(element), ',' ORDER BY ordinal), '') || ']'
      INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS item(element, ordinal);
      RETURN result;
    ELSE RETURN value::text;
  END CASE;
END $$;

ALTER TABLE "OperationEnqueueIntent"
  ADD COLUMN "payloadByteSize" integer,
  ADD COLUMN "payloadHash" char(64),
  ADD COLUMN "payloadSchemaVersion" integer NOT NULL DEFAULT 1,
  ADD COLUMN "payloadCompression" varchar(24),
  ADD COLUMN "payloadStorageKey" varchar(1024),
  ADD COLUMN "retentionUntil" timestamptz DEFAULT (now() + interval '90 days'),
  ADD COLUMN "redactedAt" timestamptz;
UPDATE "OperationEnqueueIntent" SET
  "payloadByteSize" = octet_length(canonical_jsonb_text("payload")),
  "payloadHash" = encode(digest(convert_to(canonical_jsonb_text("payload"), 'UTF8'), 'sha256'), 'hex'),
  "retentionUntil" = "createdAt" + interval '90 days';
ALTER TABLE "OperationEnqueueIntent"
  ALTER COLUMN "payloadByteSize" SET NOT NULL,
  ALTER COLUMN "payloadHash" SET NOT NULL;

ALTER TABLE "OutboxEvent"
  ADD COLUMN "payloadByteSize" integer NOT NULL DEFAULT 0,
  ADD COLUMN "payloadSchemaVersion" integer NOT NULL DEFAULT 1,
  ADD COLUMN "payloadCompression" varchar(24),
  ADD COLUMN "payloadStorageKey" varchar(1024),
  ADD COLUMN "retentionUntil" timestamptz DEFAULT (now() + interval '7 years'),
  ADD COLUMN "redactedAt" timestamptz;
UPDATE "OutboxEvent" SET
  "payloadByteSize" = octet_length(canonical_jsonb_text(COALESCE("payloadJson", 'null'::jsonb))),
  "payloadHash" = encode(digest(convert_to(canonical_jsonb_text(COALESCE("payloadJson", 'null'::jsonb)), 'UTF8'), 'sha256'), 'hex'),
  "retentionUntil" = "createdAt" + interval '7 years';

ALTER TABLE "UndoCommand"
  ADD COLUMN "payloadByteSize" integer,
  ADD COLUMN "payloadSchemaVersion" integer NOT NULL DEFAULT 1,
  ADD COLUMN "payloadCompression" varchar(24),
  ADD COLUMN "payloadStorageKey" varchar(1024),
  ADD COLUMN "retentionUntil" timestamptz DEFAULT (now() + interval '7 years'),
  ADD COLUMN "redactedAt" timestamptz;

-- The existing authority trigger correctly rejects application changes to the
-- immutable command hash. This controlled migration backfill canonicalizes that
-- hash from the already-immutable commandJson, then restores protection.
ALTER TABLE "UndoCommand" DISABLE TRIGGER "UndoCommand_reject_authority_update";
UPDATE "UndoCommand" SET
  "payloadByteSize" = octet_length(canonical_jsonb_text("commandJson")),
  "commandHash" = encode(digest(convert_to(canonical_jsonb_text("commandJson"), 'UTF8'), 'sha256'), 'hex'),
  "retentionUntil" = "createdAt" + interval '7 years';
ALTER TABLE "UndoCommand" ENABLE TRIGGER "UndoCommand_reject_authority_update";
ALTER TABLE "UndoCommand" ALTER COLUMN "payloadByteSize" SET NOT NULL;

ALTER TABLE "UndoOperationConflictChunk"
  ADD COLUMN "payloadByteSize" integer,
  ADD COLUMN "payloadHash" char(64),
  ADD COLUMN "payloadSchemaVersion" integer NOT NULL DEFAULT 1,
  ADD COLUMN "payloadCompression" varchar(24),
  ADD COLUMN "payloadStorageKey" varchar(1024);
UPDATE "UndoOperationConflictChunk" SET
  "payloadByteSize" = octet_length(canonical_jsonb_text("payload")),
  "payloadHash" = encode(digest(convert_to(canonical_jsonb_text("payload"), 'UTF8'), 'sha256'), 'hex');
ALTER TABLE "UndoOperationConflictChunk"
  ALTER COLUMN "payloadByteSize" SET NOT NULL,
  ALTER COLUMN "payloadHash" SET NOT NULL;

ALTER TABLE "TargetFreezeCommand"
  ADD COLUMN "payloadByteSize" integer,
  ADD COLUMN "payloadHash" char(64),
  ADD COLUMN "payloadSchemaVersion" integer NOT NULL DEFAULT 1,
  ADD COLUMN "payloadCompression" varchar(24),
  ADD COLUMN "payloadStorageKey" varchar(1024);
UPDATE "TargetFreezeCommand" SET
  "payloadByteSize" = octet_length(canonical_jsonb_text(jsonb_build_object(
    'shop', "shop", 'operationId', "operationId", 'sourceType', "sourceType",
    'sourceId', "sourceId", 'sourceRevision', "sourceRevision",
    'ruleConfigHash', "configFingerprint", 'mirrorBatchId', "mirrorBatchId",
    'targetResolutionMode', "targetMode", 'filterAst', "filterAstJson",
    'savedTargetSetId', "savedTargetSetId", 'editOperationJson', "editOperationJson"))),
  "payloadHash" = encode(digest(convert_to(canonical_jsonb_text(jsonb_build_object(
    'shop', "shop", 'operationId', "operationId", 'sourceType', "sourceType",
    'sourceId', "sourceId", 'sourceRevision', "sourceRevision",
    'ruleConfigHash', "configFingerprint", 'mirrorBatchId', "mirrorBatchId",
    'targetResolutionMode', "targetMode", 'filterAst', "filterAstJson",
    'savedTargetSetId', "savedTargetSetId", 'editOperationJson', "editOperationJson")), 'UTF8'), 'sha256'), 'hex');
ALTER TABLE "TargetFreezeCommand"
  ALTER COLUMN "payloadByteSize" SET NOT NULL,
  ALTER COLUMN "payloadHash" SET NOT NULL;

CREATE TABLE "LargePayloadMigrationQueue" (
  "sourceTable" text NOT NULL,
  "sourceId" text NOT NULL,
  "shop" text,
  "payloadByteSize" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING_OBJECT_STORAGE',
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("sourceTable", "sourceId")
);
INSERT INTO "LargePayloadMigrationQueue" ("sourceTable", "sourceId", "shop", "payloadByteSize")
SELECT 'OperationEnqueueIntent', "id", "shop", "payloadByteSize" FROM "OperationEnqueueIntent"
WHERE "payloadByteSize" > 262144 ON CONFLICT DO NOTHING;
INSERT INTO "LargePayloadMigrationQueue" ("sourceTable", "sourceId", "shop", "payloadByteSize")
SELECT 'OutboxEvent', "id", "shop", "payloadByteSize" FROM "OutboxEvent"
WHERE "payloadByteSize" > 131072 ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION prevent_immutable_payload_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'OperationEnqueueIntent' AND
    (NEW."payload", NEW."payloadHash", NEW."payloadByteSize", NEW."payloadSchemaVersion", NEW."payloadCompression", NEW."payloadStorageKey") IS DISTINCT FROM
    (OLD."payload", OLD."payloadHash", OLD."payloadByteSize", OLD."payloadSchemaVersion", OLD."payloadCompression", OLD."payloadStorageKey") THEN
    RAISE EXCEPTION 'IMMUTABLE_OPERATION_ENQUEUE_PAYLOAD';
  ELSIF TG_TABLE_NAME = 'OutboxEvent' AND
    (NEW."payloadJson", NEW."payloadHash", NEW."payloadByteSize", NEW."payloadSchemaVersion", NEW."payloadCompression", NEW."payloadStorageKey") IS DISTINCT FROM
    (OLD."payloadJson", OLD."payloadHash", OLD."payloadByteSize", OLD."payloadSchemaVersion", OLD."payloadCompression", OLD."payloadStorageKey") THEN
    RAISE EXCEPTION 'IMMUTABLE_OUTBOX_PAYLOAD';
  ELSIF TG_TABLE_NAME = 'UndoCommand' AND
    (NEW."commandJson", NEW."commandHash", NEW."payloadByteSize", NEW."payloadSchemaVersion", NEW."payloadCompression", NEW."payloadStorageKey") IS DISTINCT FROM
    (OLD."commandJson", OLD."commandHash", OLD."payloadByteSize", OLD."payloadSchemaVersion", OLD."payloadCompression", OLD."payloadStorageKey") THEN
    RAISE EXCEPTION 'IMMUTABLE_UNDO_COMMAND_PAYLOAD';
  ELSIF TG_TABLE_NAME = 'UndoOperationConflictChunk' AND
    (NEW."payload", NEW."payloadHash", NEW."payloadByteSize", NEW."payloadSchemaVersion", NEW."payloadCompression", NEW."payloadStorageKey") IS DISTINCT FROM
    (OLD."payload", OLD."payloadHash", OLD."payloadByteSize", OLD."payloadSchemaVersion", OLD."payloadCompression", OLD."payloadStorageKey") THEN
    RAISE EXCEPTION 'IMMUTABLE_UNDO_CONFLICT_PAYLOAD';
  ELSIF TG_TABLE_NAME = 'TargetFreezeCommand' AND
    (NEW."shop", NEW."operationId", NEW."sourceType", NEW."sourceId", NEW."sourceRevision", NEW."configFingerprint",
     NEW."mirrorBatchId", NEW."targetMode", NEW."filterAstJson", NEW."savedTargetSetId", NEW."editOperationJson",
     NEW."payloadHash", NEW."payloadByteSize", NEW."payloadSchemaVersion", NEW."payloadCompression", NEW."payloadStorageKey") IS DISTINCT FROM
    (OLD."shop", OLD."operationId", OLD."sourceType", OLD."sourceId", OLD."sourceRevision", OLD."configFingerprint",
     OLD."mirrorBatchId", OLD."targetMode", OLD."filterAstJson", OLD."savedTargetSetId", OLD."editOperationJson",
     OLD."payloadHash", OLD."payloadByteSize", OLD."payloadSchemaVersion", OLD."payloadCompression", OLD."payloadStorageKey") THEN
    RAISE EXCEPTION 'IMMUTABLE_TARGET_FREEZE_COMMAND_PAYLOAD';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "OperationEnqueueIntent_payload_immutable_trg" BEFORE UPDATE ON "OperationEnqueueIntent"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_payload_update();
CREATE TRIGGER "OutboxEvent_payload_immutable_trg" BEFORE UPDATE ON "OutboxEvent"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_payload_update();
CREATE TRIGGER "UndoCommand_payload_immutable_trg" BEFORE UPDATE ON "UndoCommand"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_payload_update();
CREATE TRIGGER "UndoOperationConflictChunk_payload_immutable_trg" BEFORE UPDATE ON "UndoOperationConflictChunk"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_payload_update();
CREATE TRIGGER "TargetFreezeCommand_payload_immutable_trg" BEFORE UPDATE ON "TargetFreezeCommand"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_payload_update();

-- Explicit retention; no historical rows are deleted by this migration.
ALTER TABLE "EditHistory" ADD COLUMN "retentionUntil" timestamptz DEFAULT (now() + interval '7 years'), ADD COLUMN "redactedAt" timestamptz;
ALTER TABLE "UndoOperation" ADD COLUMN "retentionUntil" timestamptz DEFAULT (now() + interval '7 years'), ADD COLUMN "redactedAt" timestamptz;
ALTER TABLE "BulkEditRecoveryAudit" ADD COLUMN "retentionUntil" timestamptz DEFAULT (now() + interval '7 years'), ADD COLUMN "redactedAt" timestamptz;
ALTER TABLE "ChangeRecord" ADD COLUMN "retentionUntil" timestamptz DEFAULT (now() + interval '7 years'), ADD COLUMN "redactedAt" timestamptz;
UPDATE "EditHistory" SET "retentionUntil" = "createdAt" + interval '7 years' WHERE "retentionUntil" IS NULL;
UPDATE "UndoOperation" SET "retentionUntil" = "createdAt" + interval '7 years' WHERE "retentionUntil" IS NULL;
UPDATE "BulkEditRecoveryAudit" SET "retentionUntil" = "createdAt" + interval '7 years' WHERE "retentionUntil" IS NULL;
UPDATE "ChangeRecord" SET "retentionUntil" = "createdAt" + interval '7 years' WHERE "retentionUntil" IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "UndoOperation" u LEFT JOIN "EditHistory" h
    ON h."shop" = u."shop" AND h."id" = u."sourceEditHistoryId" WHERE h."id" IS NULL) THEN
    RAISE EXCEPTION 'ORPHANED_UNDO_OPERATION';
  END IF;
END $$;
ALTER TABLE "UndoOperation" DROP CONSTRAINT IF EXISTS "UndoOperation_shop_sourceEditHistoryId_fkey";
ALTER TABLE "UndoOperation" ADD CONSTRAINT "UndoOperation_shop_sourceEditHistoryId_fkey"
FOREIGN KEY ("shop", "sourceEditHistoryId") REFERENCES "EditHistory"("shop", "id") ON DELETE RESTRICT NOT VALID;
ALTER TABLE "UndoOperation" VALIDATE CONSTRAINT "UndoOperation_shop_sourceEditHistoryId_fkey";
ALTER TABLE "UndoItem" DROP CONSTRAINT IF EXISTS "UndoItem_shop_undoOperationId_fkey";
ALTER TABLE "UndoItem" ADD CONSTRAINT "UndoItem_shop_undoOperationId_fkey"
FOREIGN KEY ("shop", "undoOperationId") REFERENCES "UndoOperation"("shop", "id") ON DELETE RESTRICT NOT VALID;
ALTER TABLE "UndoItem" VALIDATE CONSTRAINT "UndoItem_shop_undoOperationId_fkey";
ALTER TABLE "UndoCommand" DROP CONSTRAINT IF EXISTS "UndoCommand_shop_undoOperationId_fkey";
ALTER TABLE "UndoCommand" ADD CONSTRAINT "UndoCommand_shop_undoOperationId_fkey"
FOREIGN KEY ("shop", "undoOperationId") REFERENCES "UndoOperation"("shop", "id") ON DELETE RESTRICT NOT VALID;
ALTER TABLE "UndoCommand" VALIDATE CONSTRAINT "UndoCommand_shop_undoOperationId_fkey";
ALTER TABLE "UndoOperationConflictChunk" DROP CONSTRAINT IF EXISTS "UndoOperationConflictChunk_shop_undoOperationId_fkey";
ALTER TABLE "UndoOperationConflictChunk" ADD CONSTRAINT "UndoOperationConflictChunk_shop_undoOperationId_fkey"
FOREIGN KEY ("shop", "undoOperationId") REFERENCES "UndoOperation"("shop", "id") ON DELETE RESTRICT NOT VALID;
ALTER TABLE "UndoOperationConflictChunk" VALIDATE CONSTRAINT "UndoOperationConflictChunk_shop_undoOperationId_fkey";
ALTER TABLE "BulkEditRecoveryAudit" DROP CONSTRAINT IF EXISTS "BulkEditRecoveryAudit_shop_historyId_fkey";
ALTER TABLE "BulkEditRecoveryAudit" ADD CONSTRAINT "BulkEditRecoveryAudit_shop_historyId_fkey"
FOREIGN KEY ("shop", "historyId") REFERENCES "EditHistory"("shop", "id") ON DELETE RESTRICT NOT VALID;
ALTER TABLE "BulkEditRecoveryAudit" VALIDATE CONSTRAINT "BulkEditRecoveryAudit_shop_historyId_fkey";
ALTER TABLE "EditHistoryIngestionCheckpoint" DROP CONSTRAINT IF EXISTS "EditHistoryIngestionCheckpoint_shop_historyId_fkey";
ALTER TABLE "EditHistoryIngestionCheckpoint" ADD CONSTRAINT "EditHistoryIngestionCheckpoint_shop_historyId_fkey"
FOREIGN KEY ("shop", "historyId") REFERENCES "EditHistory"("shop", "id") ON DELETE RESTRICT NOT VALID;
ALTER TABLE "EditHistoryIngestionCheckpoint" VALIDATE CONSTRAINT "EditHistoryIngestionCheckpoint_shop_historyId_fkey";
ALTER TABLE "ChangeRecord" DROP CONSTRAINT IF EXISTS "ChangeRecord_shop_editHistoryId_fkey";
ALTER TABLE "ChangeRecord" ADD CONSTRAINT "ChangeRecord_shop_editHistoryId_fkey"
FOREIGN KEY ("shop", "editHistoryId") REFERENCES "EditHistory"("shop", "id") ON DELETE RESTRICT NOT VALID;
ALTER TABLE "ChangeRecord" VALIDATE CONSTRAINT "ChangeRecord_shop_editHistoryId_fkey";
ALTER TABLE "EditHistory" DROP CONSTRAINT IF EXISTS "EditHistory_shop_snapshotSetId_fkey";
ALTER TABLE "EditHistory" ADD CONSTRAINT "EditHistory_shop_snapshotSetId_fkey"
FOREIGN KEY ("shop", "snapshotSetId") REFERENCES "TargetSnapshotSet"("shop", "id") ON DELETE RESTRICT NOT VALID;
ALTER TABLE "EditHistory" VALIDATE CONSTRAINT "EditHistory_shop_snapshotSetId_fkey";
ALTER TABLE "MirrorMutationJournal" DROP CONSTRAINT IF EXISTS "MirrorMutationJournal_shop_webhookDeliveryId_fkey";
ALTER TABLE "MirrorMutationJournal" ADD CONSTRAINT "MirrorMutationJournal_shop_webhookDeliveryId_fkey"
FOREIGN KEY ("shop", "webhookDeliveryId") REFERENCES "WebhookDelivery"("shop", "id") ON DELETE RESTRICT NOT VALID;
ALTER TABLE "MirrorMutationJournal" VALIDATE CONSTRAINT "MirrorMutationJournal_shop_webhookDeliveryId_fkey";

CREATE INDEX "OperationEnqueueIntent_terminal_retention_idx" ON "OperationEnqueueIntent" ("retentionUntil", "id")
WHERE "status" IN ('DISPATCHED', 'FAILED') AND "retentionUntil" IS NOT NULL;
CREATE INDEX "OutboxEvent_terminal_retention_idx" ON "OutboxEvent" ("retentionUntil", "id")
WHERE "status" IN ('DISPATCHED', 'DEAD_LETTER') AND "retentionUntil" IS NOT NULL;
CREATE INDEX "EditHistory_terminal_retention_idx" ON "EditHistory" ("shop", "retentionUntil", "id")
WHERE "status" IN ('completed', 'failed', 'cancelled', 'partial') AND "retentionUntil" IS NOT NULL;
CREATE INDEX "UndoOperation_terminal_retention_idx" ON "UndoOperation" ("shop", "retentionUntil", "id")
WHERE "status" IN ('completed', 'partial', 'failed', 'cancelled') AND "retentionUntil" IS NOT NULL;
