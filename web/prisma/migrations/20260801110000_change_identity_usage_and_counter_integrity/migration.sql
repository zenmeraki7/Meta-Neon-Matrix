CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Normalize legacy aggregate ChangeRecord JSON into one row per field wherever
-- the original mutation structure is provable.
ALTER TABLE "ChangeRecord"
  ADD COLUMN IF NOT EXISTS "changeIdentity" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "executionAttempt" INTEGER DEFAULT 1;

INSERT INTO "ChangeRecord"
SELECT (
  jsonb_populate_record(
    NULL::"ChangeRecord",
    to_jsonb(record) || jsonb_build_object(
      'id', gen_random_uuid()::text,
      'fieldPath', 'product.' || lower(regexp_replace(change.value->>'field', '[^a-zA-Z0-9]+', '_', 'g')),
      'productFieldChanges', jsonb_build_array(change.value),
      'variantFieldChanges', '[]'::jsonb,
      'afterValues', jsonb_build_object('productFieldChanges', jsonb_build_array(change.value), 'variantFieldChanges', '[]'::jsonb),
      'changeIdentity', NULL,
      'executionAttempt', 1
    )
  )
).*
FROM "ChangeRecord" record
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(record."productFieldChanges") = 'array'
    THEN record."productFieldChanges" ELSE '[]'::jsonb END
) WITH ORDINALITY AS change(value, ordinality)
WHERE record."fieldPath" LIKE 'legacy.atomic.%'
  AND NULLIF(btrim(change.value->>'field'), '') IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO "ChangeRecord"
SELECT (
  jsonb_populate_record(
    NULL::"ChangeRecord",
    to_jsonb(record) || jsonb_build_object(
      'id', gen_random_uuid()::text,
      'targetType', 'VARIANT',
      'targetIdentity', COALESCE(NULLIF(group_row.value->>'variantId', ''), record."targetIdentity"),
      'variantId', COALESCE(NULLIF(group_row.value->>'variantId', ''), record."variantId"),
      'fieldPath', 'variant.' || lower(regexp_replace(change.value->>'field', '[^a-zA-Z0-9]+', '_', 'g')),
      'productFieldChanges', '[]'::jsonb,
      'variantFieldChanges', jsonb_build_array(group_row.value || jsonb_build_object('changes', jsonb_build_array(change.value))),
      'afterValues', jsonb_build_object('productFieldChanges', '[]'::jsonb, 'variantFieldChanges', jsonb_build_array(group_row.value || jsonb_build_object('changes', jsonb_build_array(change.value)))),
      'changeIdentity', NULL,
      'executionAttempt', 1
    )
  )
).*
FROM "ChangeRecord" record
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(record."variantFieldChanges") = 'array'
    THEN record."variantFieldChanges" ELSE '[]'::jsonb END
) AS group_row(value)
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(group_row.value->'changes') = 'array'
    THEN group_row.value->'changes' ELSE jsonb_build_array(group_row.value) END
) AS change(value)
WHERE record."fieldPath" LIKE 'legacy.atomic.%'
  AND NULLIF(btrim(change.value->>'field'), '') IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE TABLE "ChangeRecordUnprovableFieldChange" AS
SELECT record.*, CURRENT_TIMESTAMP AS "quarantinedAt"
FROM "ChangeRecord" record
WHERE record."fieldPath" LIKE 'legacy.atomic.%'
  AND (
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(record."productFieldChanges")='array' THEN record."productFieldChanges" ELSE '[]'::jsonb END) change
      WHERE NULLIF(btrim(change->>'field'), '') IS NULL
    )
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(record."variantFieldChanges")='array' THEN record."variantFieldChanges" ELSE '[]'::jsonb END) group_row,
      LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(group_row->'changes')='array' THEN group_row->'changes' ELSE jsonb_build_array(group_row) END) change
      WHERE NULLIF(btrim(change->>'field'), '') IS NULL
    )
  );

DELETE FROM "ChangeRecord" record
WHERE record."fieldPath" LIKE 'legacy.atomic.%'
  AND NOT EXISTS (SELECT 1 FROM "ChangeRecordUnprovableFieldChange" q WHERE q."id"=record."id")
  AND (
    jsonb_array_length(CASE WHEN jsonb_typeof(record."productFieldChanges") = 'array' THEN record."productFieldChanges" ELSE '[]'::jsonb END) > 0
    OR jsonb_array_length(CASE WHEN jsonb_typeof(record."variantFieldChanges") = 'array' THEN record."variantFieldChanges" ELSE '[]'::jsonb END) > 0
  );

UPDATE "ChangeRecord"
SET "executionAttempt" = COALESCE("executionAttempt", 1);

-- Capture duplicates using null-safe comparison before deterministic collapse.
CREATE TABLE "ChangeRecordIdentityDuplicate" AS
SELECT record.*, CURRENT_TIMESTAMP AS "quarantinedAt"
FROM "ChangeRecord" record
WHERE EXISTS (
  SELECT 1
  FROM "ChangeRecord" candidate
  WHERE candidate."id" <> record."id"
    AND candidate."shop" IS NOT DISTINCT FROM record."shop"
    AND candidate."editHistoryId" IS NOT DISTINCT FROM record."editHistoryId"
    AND candidate."targetIdentity" IS NOT DISTINCT FROM record."targetIdentity"
    AND candidate."fieldPath" IS NOT DISTINCT FROM record."fieldPath"
    AND candidate."executionAttempt" IS NOT DISTINCT FROM record."executionAttempt"
);

WITH ranked AS (
  SELECT "id",
    first_value("id") OVER (
      PARTITION BY "shop", "editHistoryId", "targetIdentity", "fieldPath", "executionAttempt"
      ORDER BY
        CASE upper("status")
          WHEN 'SUCCESS' THEN 4 WHEN 'SUCCEEDED' THEN 4 WHEN 'VERIFIED' THEN 4
          WHEN 'FAILED' THEN 3 WHEN 'SKIPPED' THEN 2 ELSE 1
        END DESC,
        "updatedAt" DESC,
        "createdAt" DESC,
        "id"
    ) AS winner_id,
    row_number() OVER (
      PARTITION BY "shop", "editHistoryId", "targetIdentity", "fieldPath", "executionAttempt"
      ORDER BY
        CASE upper("status")
          WHEN 'SUCCESS' THEN 4 WHEN 'SUCCEEDED' THEN 4 WHEN 'VERIFIED' THEN 4
          WHEN 'FAILED' THEN 3 WHEN 'SKIPPED' THEN 2 ELSE 1
        END DESC,
        "updatedAt" DESC,
        "createdAt" DESC,
        "id"
    ) AS duplicate_rank
  FROM "ChangeRecord"
)
DELETE FROM "ChangeRecord" record
USING ranked
WHERE record."id" = ranked."id" AND ranked.duplicate_rank > 1;

UPDATE "ChangeRecord"
SET "changeIdentity" = encode(digest(
  "shop" || chr(31) || "editHistoryId" || chr(31) || "targetIdentity" || chr(31) || "fieldPath" || chr(31) || "executionAttempt"::text,
  'sha256'
), 'hex');

DROP INDEX IF EXISTS "uniq_change_record_shop_history_batch_target_field";
ALTER TABLE "ChangeRecord"
  ALTER COLUMN "changeIdentity" SET NOT NULL,
  ALTER COLUMN "executionAttempt" SET NOT NULL;
CREATE UNIQUE INDEX "ChangeRecord_authoritative_field_attempt_uq"
  ON "ChangeRecord" ("shop", "editHistoryId", "targetIdentity", "fieldPath", "executionAttempt");
CREATE UNIQUE INDEX "ChangeRecord_shop_changeIdentity_uq"
  ON "ChangeRecord" ("shop", "changeIdentity");
ALTER TABLE "ChangeRecord" ADD CONSTRAINT "ChangeRecord_executionAttempt_nonnegative_check"
  CHECK ("executionAttempt" >= 1) NOT VALID;
ALTER TABLE "ChangeRecord" VALIDATE CONSTRAINT "ChangeRecord_executionAttempt_nonnegative_check";

-- Long-lived schedule counters cannot safely remain 32-bit.
ALTER TABLE "RecurringEdit" ALTER COLUMN "runCount" TYPE BIGINT USING GREATEST("runCount", 0)::bigint;
ALTER TABLE "AutomaticProductRule" ALTER COLUMN "runCount" TYPE BIGINT USING GREATEST("runCount", 0)::bigint;
ALTER TABLE "ScheduledExport" ALTER COLUMN "runCount" TYPE BIGINT USING GREATEST("runCount", 0)::bigint;

-- Rebuild aggregate projections from authoritative item/change rows.
UPDATE "EditHistory" history
SET "processedCount" = counts.processed,
    "totalItems" = GREATEST(history."totalItems", counts.total)
FROM (
  SELECT "shop", "editHistoryId", COUNT(*)::integer AS total,
    COUNT(*) FILTER (WHERE upper("status") IN ('SUCCESS','SUCCEEDED','VERIFIED','FAILED','SKIPPED'))::integer AS processed
  FROM "ChangeRecord"
  GROUP BY "shop", "editHistoryId"
) counts
WHERE counts."shop" = history."shop" AND counts."editHistoryId" = history."id";

UPDATE "UndoOperation" operation
SET "totalEligibleCount" = counts.total,
    "processedCount" = counts.terminal,
    "restoredCount" = counts.restored,
    "failedCount" = counts.failed,
    "skippedCount" = counts.skipped,
    "conflictedCount" = counts.conflicted
FROM (
  SELECT "shop", "undoOperationId", COUNT(*)::integer AS total,
    COUNT(*) FILTER (WHERE "outcome"::text IN ('RESTORED','FAILED','SKIPPED','CONFLICT','MANUAL_REVIEW'))::integer AS terminal,
    COUNT(*) FILTER (WHERE "outcome"::text = 'RESTORED')::integer AS restored,
    COUNT(*) FILTER (WHERE "outcome"::text IN ('FAILED','MANUAL_REVIEW'))::integer AS failed,
    COUNT(*) FILTER (WHERE "outcome"::text = 'SKIPPED')::integer AS skipped,
    COUNT(*) FILTER (WHERE "outcome"::text = 'CONFLICT')::integer AS conflicted
  FROM "UndoItem" GROUP BY "shop", "undoOperationId"
) counts
WHERE counts."shop" = operation."shop" AND counts."undoOperationId" = operation."id";

UPDATE "TargetSnapshotSet" setrow SET
  "targetCount" = counts.total,
  "productCount" = counts.products,
  "variantCount" = counts.variants,
  "inventoryItemCount" = counts.inventory_items,
  "metafieldCount" = counts.metafields,
  "productOptionCount" = counts.product_options,
  "collectionMembershipCount" = counts.collection_memberships,
  "inventoryLevelCount" = counts.inventory_levels,
  "pendingCount" = counts.pending,
  "submittedCount" = counts.submitted,
  "succeededCount" = counts.succeeded,
  "failedCount" = counts.failed,
  "skippedCount" = counts.skipped,
  "verificationPendingCount" = counts.verification_pending,
  "verifiedCount" = counts.verification_succeeded,
  "verificationFailedCount" = counts.verification_failed,
  "undoNotRequiredCount" = counts.undo_not_required,
  "undoPendingCount" = counts.undo_pending,
  "undoSubmittedCount" = counts.undo_submitted,
  "undoSucceededCount" = counts.undo_succeeded,
  "undoFailedCount" = counts.undo_failed,
  "undoSkippedCount" = counts.undo_skipped
FROM (
  SELECT "shop", "snapshotSetId", COUNT(*)::integer AS total,
    COUNT(*) FILTER (WHERE "targetType"::text='PRODUCT')::integer AS products,
    COUNT(*) FILTER (WHERE "targetType"::text='VARIANT')::integer AS variants,
    COUNT(*) FILTER (WHERE "targetType"::text='INVENTORY_ITEM')::integer AS inventory_items,
    COUNT(*) FILTER (WHERE "targetType"::text='METAFIELD')::integer AS metafields,
    COUNT(*) FILTER (WHERE "targetType"::text='PRODUCT_OPTION')::integer AS product_options,
    COUNT(*) FILTER (WHERE "targetType"::text='COLLECTION_MEMBERSHIP')::integer AS collection_memberships,
    COUNT(*) FILTER (WHERE "targetType"::text='INVENTORY_LEVEL')::integer AS inventory_levels,
    COUNT(*) FILTER (WHERE "executionStatus"::text IN ('PENDING','DEFERRED'))::integer AS pending,
    COUNT(*) FILTER (WHERE "executionStatus"::text='SUBMITTED')::integer AS submitted,
    COUNT(*) FILTER (WHERE "executionStatus"::text='SUCCEEDED')::integer AS succeeded,
    COUNT(*) FILTER (WHERE "executionStatus"::text='FAILED')::integer AS failed,
    COUNT(*) FILTER (WHERE "executionStatus"::text IN ('SKIPPED','CANCELLED'))::integer AS skipped,
    COUNT(*) FILTER (WHERE "verificationStatus"::text='PENDING')::integer AS verification_pending,
    COUNT(*) FILTER (WHERE "verificationStatus"::text='SUCCEEDED')::integer AS verification_succeeded,
    COUNT(*) FILTER (WHERE "verificationStatus"::text='FAILED')::integer AS verification_failed,
    COUNT(*) FILTER (WHERE "undoStatus"::text='NOT_REQUIRED')::integer AS undo_not_required,
    COUNT(*) FILTER (WHERE "undoStatus"::text='PENDING')::integer AS undo_pending,
    COUNT(*) FILTER (WHERE "undoStatus"::text='SUBMITTED')::integer AS undo_submitted,
    COUNT(*) FILTER (WHERE "undoStatus"::text='SUCCEEDED')::integer AS undo_succeeded,
    COUNT(*) FILTER (WHERE "undoStatus"::text='FAILED')::integer AS undo_failed,
    COUNT(*) FILTER (WHERE "undoStatus"::text='SKIPPED')::integer AS undo_skipped
  FROM "TargetSnapshotItem" GROUP BY "shop", "snapshotSetId"
) counts
WHERE counts."shop"=setrow."shop" AND counts."snapshotSetId"=setrow."id";

UPDATE "EditHistory" SET
  "processedCount"=GREATEST("processedCount",0), "totalItems"=GREATEST("totalItems","processedCount",0),
  "totalRows"=GREATEST("totalRows",0), "durationMs"=GREATEST("durationMs",0),
  "targetSnapshotCount"=GREATEST("targetSnapshotCount",0);
UPDATE "UndoOperation" SET
  "restoredCount"=GREATEST("restoredCount",0), "failedCount"=GREATEST("failedCount",0),
  "skippedCount"=GREATEST("skippedCount",0), "conflictedCount"=GREATEST("conflictedCount",0);
UPDATE "UndoOperation" SET
  "processedCount"="restoredCount"+"failedCount"+"skippedCount"+"conflictedCount",
  "totalEligibleCount"=GREATEST("totalEligibleCount","restoredCount"+"failedCount"+"skippedCount"+"conflictedCount",0);

ALTER TABLE "EditHistory" ADD CONSTRAINT "EditHistory_counters_nonnegative_check"
  CHECK ("processedCount" >= 0 AND "totalItems" >= 0 AND "totalRows" >= 0 AND "durationMs" >= 0 AND "targetSnapshotCount" >= 0) NOT VALID;
ALTER TABLE "EditHistory" ADD CONSTRAINT "EditHistory_processed_total_check"
  CHECK ("totalItems" = 0 OR "processedCount" <= "totalItems") NOT VALID;
ALTER TABLE "UndoOperation" ADD CONSTRAINT "UndoOperation_counters_nonnegative_check"
  CHECK ("processedCount" >= 0 AND "totalEligibleCount" >= 0 AND "restoredCount" >= 0 AND "failedCount" >= 0 AND "skippedCount" >= 0 AND "conflictedCount" >= 0) NOT VALID;
ALTER TABLE "UndoOperation" ADD CONSTRAINT "UndoOperation_terminal_total_check"
  CHECK ("processedCount" = "restoredCount" + "failedCount" + "skippedCount" + "conflictedCount" AND "processedCount" <= "totalEligibleCount") NOT VALID;
ALTER TABLE "TargetSnapshotSet" ADD CONSTRAINT "TargetSnapshotSet_counters_nonnegative_check"
  CHECK (LEAST("targetCount","productCount","variantCount","inventoryItemCount","metafieldCount","productOptionCount","collectionMembershipCount","inventoryLevelCount","pendingCount","submittedCount","succeededCount","failedCount","skippedCount","verificationPendingCount","verifiedCount","verificationFailedCount","undoNotRequiredCount","undoPendingCount","undoSubmittedCount","undoSucceededCount","undoFailedCount","undoSkippedCount") >= 0) NOT VALID;
ALTER TABLE "TargetSnapshotSet" ADD CONSTRAINT "TargetSnapshotSet_type_total_check"
  CHECK ("targetCount" = "productCount" + "variantCount" + "inventoryItemCount" + "metafieldCount" + "productOptionCount" + "collectionMembershipCount" + "inventoryLevelCount") NOT VALID;
ALTER TABLE "TargetSnapshotSet" ADD CONSTRAINT "TargetSnapshotSet_execution_total_check"
  CHECK ("targetCount" = "pendingCount" + "submittedCount" + "succeededCount" + "failedCount" + "skippedCount") NOT VALID;
ALTER TABLE "TargetSnapshotSet" ADD CONSTRAINT "TargetSnapshotSet_verification_total_check"
  CHECK ("verificationPendingCount" + "verifiedCount" + "verificationFailedCount" <= "targetCount") NOT VALID;
ALTER TABLE "TargetSnapshotSet" ADD CONSTRAINT "TargetSnapshotSet_undo_total_check"
  CHECK ("targetCount" = "undoNotRequiredCount" + "undoPendingCount" + "undoSubmittedCount" + "undoSucceededCount" + "undoFailedCount" + "undoSkippedCount") NOT VALID;

ALTER TABLE "EditHistory" VALIDATE CONSTRAINT "EditHistory_counters_nonnegative_check";
ALTER TABLE "EditHistory" VALIDATE CONSTRAINT "EditHistory_processed_total_check";
ALTER TABLE "UndoOperation" VALIDATE CONSTRAINT "UndoOperation_counters_nonnegative_check";
ALTER TABLE "UndoOperation" VALIDATE CONSTRAINT "UndoOperation_terminal_total_check";
ALTER TABLE "TargetSnapshotSet" VALIDATE CONSTRAINT "TargetSnapshotSet_counters_nonnegative_check";
ALTER TABLE "TargetSnapshotSet" VALIDATE CONSTRAINT "TargetSnapshotSet_type_total_check";
ALTER TABLE "TargetSnapshotSet" VALIDATE CONSTRAINT "TargetSnapshotSet_execution_total_check";
ALTER TABLE "TargetSnapshotSet" VALIDATE CONSTRAINT "TargetSnapshotSet_verification_total_check";
ALTER TABLE "TargetSnapshotSet" VALIDATE CONSTRAINT "TargetSnapshotSet_undo_total_check";

CREATE TABLE "UsagePeriod" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "entitlementKey" TEXT NOT NULL,
  "periodStartsAt" TIMESTAMP(3) NOT NULL,
  "periodEndsAt" TIMESTAMP(3) NOT NULL,
  "reservedAmount" BIGINT NOT NULL DEFAULT 0,
  "consumedAmount" BIGINT NOT NULL DEFAULT 0,
  "releasedAmount" BIGINT NOT NULL DEFAULT 0,
  "billingAuthorityVersion" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UsagePeriod_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UsagePeriod_amounts_check" CHECK ("reservedAmount" >= 0 AND "consumedAmount" >= 0 AND "releasedAmount" >= 0 AND "consumedAmount" + "releasedAmount" <= "reservedAmount"),
  CONSTRAINT "UsagePeriod_dates_check" CHECK ("periodEndsAt" > "periodStartsAt")
);
CREATE UNIQUE INDEX "UsagePeriod_shop_id_key" ON "UsagePeriod" ("shop","id");
CREATE UNIQUE INDEX "UsagePeriod_shop_entitlement_period_key" ON "UsagePeriod" ("shop","entitlementKey","periodStartsAt","periodEndsAt");
CREATE INDEX "UsagePeriod_shop_entitlement_end_idx" ON "UsagePeriod" ("shop","entitlementKey","periodEndsAt");

CREATE TABLE "UsageReservation" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "usagePeriodId" TEXT NOT NULL,
  "entitlementKey" TEXT NOT NULL,
  "operationType" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "reservedAmount" BIGINT NOT NULL,
  "consumedAmount" BIGINT NOT NULL DEFAULT 0,
  "releasedAmount" BIGINT NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'RESERVED',
  "idempotencyKey" TEXT NOT NULL,
  "billingAuthorityVersion" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  CONSTRAINT "UsageReservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UsageReservation_amounts_check" CHECK ("reservedAmount" > 0 AND "consumedAmount" >= 0 AND "releasedAmount" >= 0 AND "consumedAmount" + "releasedAmount" <= "reservedAmount"),
  CONSTRAINT "UsageReservation_status_check" CHECK ("status" IN ('RESERVED','PARTIALLY_CONSUMED','CONSUMED','RELEASED'))
);
CREATE UNIQUE INDEX "UsageReservation_shop_id_key" ON "UsageReservation" ("shop","id");
CREATE UNIQUE INDEX "UsageReservation_operation_entitlement_key" ON "UsageReservation" ("shop","operationType","operationId","entitlementKey");
CREATE UNIQUE INDEX "UsageReservation_shop_idempotency_key" ON "UsageReservation" ("shop","idempotencyKey");
CREATE INDEX "UsageReservation_shop_period_idx" ON "UsageReservation" ("shop","usagePeriodId");

CREATE TABLE "UsageLedgerEntry" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "usagePeriodId" TEXT NOT NULL,
  "reservationId" TEXT NOT NULL,
  "entitlementKey" TEXT NOT NULL,
  "operationType" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "entryType" TEXT NOT NULL,
  "amount" BIGINT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "billingAuthorityVersion" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UsageLedgerEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UsageLedgerEntry_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "UsageLedgerEntry_type_check" CHECK ("entryType" IN ('RESERVED','CONSUMED','RELEASED'))
);
CREATE UNIQUE INDEX "UsageLedgerEntry_shop_id_key" ON "UsageLedgerEntry" ("shop","id");
CREATE UNIQUE INDEX "UsageLedgerEntry_shop_idempotency_key" ON "UsageLedgerEntry" ("shop","idempotencyKey");
CREATE INDEX "UsageLedgerEntry_shop_period_created_idx" ON "UsageLedgerEntry" ("shop","usagePeriodId","createdAt");
CREATE INDEX "UsageLedgerEntry_shop_reservation_created_idx" ON "UsageLedgerEntry" ("shop","reservationId","createdAt");

ALTER TABLE "UsagePeriod" ADD CONSTRAINT "UsagePeriod_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Store"("shopUrl") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UsageReservation" ADD CONSTRAINT "UsageReservation_period_fkey" FOREIGN KEY ("shop","usagePeriodId") REFERENCES "UsagePeriod"("shop","id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UsageLedgerEntry" ADD CONSTRAINT "UsageLedgerEntry_period_fkey" FOREIGN KEY ("shop","usagePeriodId") REFERENCES "UsagePeriod"("shop","id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UsageLedgerEntry" ADD CONSTRAINT "UsageLedgerEntry_reservation_fkey" FOREIGN KEY ("shop","reservationId") REFERENCES "UsageReservation"("shop","id") ON DELETE RESTRICT ON UPDATE CASCADE;
