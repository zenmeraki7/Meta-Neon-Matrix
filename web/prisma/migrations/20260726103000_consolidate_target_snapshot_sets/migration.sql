-- Consolidate all frozen targets onto TargetSnapshotSet -> TargetSnapshotItem.
-- The guards deliberately abort instead of dropping data when an old owner spans
-- batches or contains a target type the canonical item enum cannot represent.

ALTER TABLE "TargetSnapshotItem"
  ALTER COLUMN "productId" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "collectionId" TEXT,
  ADD COLUMN IF NOT EXISTS "inventoryItemId" TEXT,
  ADD COLUMN IF NOT EXISTS "locationId" TEXT,
  ADD COLUMN IF NOT EXISTS "targetGranularity" TEXT,
  ADD COLUMN IF NOT EXISTS "ordinal" INTEGER;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "TargetSnapshot"
    GROUP BY "shop", "ownerType", "ownerId"
    HAVING COUNT(DISTINCT "mirrorBatchId") > 1
  ) THEN
    RAISE EXCEPTION 'Standalone target snapshot owner spans multiple mirror batches';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "TargetSnapshot"
    WHERE "targetType" NOT IN ('PRODUCT', 'VARIANT', 'INVENTORY_ITEM', 'METAFIELD')
  ) THEN
    RAISE EXCEPTION 'Standalone target snapshot contains an unsupported target type';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "TargetSnapshot" oldrow
    JOIN "TargetSnapshotSet" setrow
      ON setrow."shop" = oldrow."shop"
     AND setrow."operationId" = oldrow."ownerType" || ':' || oldrow."ownerId"
    WHERE setrow."mirrorBatchId" <> oldrow."mirrorBatchId"
  ) THEN
    RAISE EXCEPTION 'Existing target snapshot set uses a different mirror batch';
  END IF;
END $$;

INSERT INTO "TargetSnapshotSet" (
  "id", "shop", "operationId", "previewContractId", "mirrorBatchId",
  "targetingFingerprint", "compilerVersion", "projectionVersion", "status",
  "createdAt", "frozenAt"
)
SELECT
  'legacy-tss-' || md5(oldrow."shop" || ':' || oldrow."ownerType" || ':' || oldrow."ownerId"),
  oldrow."shop",
  oldrow."ownerType" || ':' || oldrow."ownerId",
  oldrow."ownerType" || ':' || oldrow."ownerId",
  MIN(oldrow."mirrorBatchId"),
  COALESCE(MAX(oldrow."filterHash"), md5(oldrow."shop" || ':' || oldrow."ownerType" || ':' || oldrow."ownerId")),
  'standalone-snapshot-backfill-v1',
  'canonical-target-item-v1',
  'FREEZING'::"TargetSnapshotSetStatus",
  MIN(oldrow."createdAt"),
  CURRENT_TIMESTAMP
FROM "TargetSnapshot" oldrow
GROUP BY oldrow."shop", oldrow."ownerType", oldrow."ownerId"
ON CONFLICT ("shop", "operationId") DO NOTHING;

WITH ranked AS (
  SELECT
    oldrow.*,
    ROW_NUMBER() OVER (
      PARTITION BY oldrow."shop", oldrow."ownerType", oldrow."ownerId"
      ORDER BY oldrow."ordinal" NULLS LAST, oldrow."id"
    ) - 1 AS fallback_ordinal
  FROM "TargetSnapshot" oldrow
)
INSERT INTO "TargetSnapshotItem" (
  "id", "snapshotSetId", "shop", "operationId", "mirrorBatchId",
  "productId", "variantId", "collectionId", "inventoryItemId", "locationId",
  "targetKey", "targetType", "targetGranularity", "ordinal", "mutationGroupKey",
  "beforeValues", "plannedMutation", "targetFingerprint", "rowChecksum",
  "executionStatus", "undoStatus", "createdAt"
)
SELECT
  'legacy-tsi-' || md5(ranked."shop" || ':' || ranked."ownerType" || ':' || ranked."ownerId" || ':' || ranked."id"),
  setrow."id",
  ranked."shop",
  setrow."operationId",
  ranked."mirrorBatchId",
  ranked."productId",
  ranked."variantId",
  ranked."collectionId",
  ranked."inventoryItemId",
  ranked."locationId",
  ranked."targetIdentity",
  ranked."targetType"::"TargetSnapshotTargetType",
  ranked."targetGranularity",
  COALESCE(ranked."ordinal", ranked.fallback_ordinal::integer),
  ranked."source",
  COALESCE(ranked."beforeValues", '{}'::jsonb),
  COALESCE(ranked."beforeValues"->'plannedMutation', '{}'::jsonb),
  COALESCE(ranked."targetHash", md5(ranked."targetIdentity")),
  md5(
    ranked."shop" || ':' || setrow."operationId" || ':' ||
    ranked."mirrorBatchId" || ':' || ranked."targetIdentity" || ':' ||
    COALESCE(ranked."beforeValues", '{}'::jsonb)::text
  ),
  'PENDING'::"TargetSnapshotItemExecutionStatus",
  'NOT_REQUIRED'::"TargetSnapshotItemUndoStatus",
  ranked."createdAt"
FROM ranked
JOIN "TargetSnapshotSet" setrow
  ON setrow."shop" = ranked."shop"
 AND setrow."operationId" = ranked."ownerType" || ':' || ranked."ownerId"
 AND setrow."mirrorBatchId" = ranked."mirrorBatchId"
ON CONFLICT ("snapshotSetId", "targetKey") DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "TargetSnapshot" oldrow
    LEFT JOIN "TargetSnapshotSet" setrow
      ON setrow."shop" = oldrow."shop"
     AND setrow."operationId" = oldrow."ownerType" || ':' || oldrow."ownerId"
     AND setrow."mirrorBatchId" = oldrow."mirrorBatchId"
    LEFT JOIN "TargetSnapshotItem" item
      ON item."shop" = oldrow."shop"
     AND item."snapshotSetId" = setrow."id"
     AND item."mirrorBatchId" = oldrow."mirrorBatchId"
     AND item."targetKey" = oldrow."targetIdentity"
    WHERE item."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Standalone target snapshot backfill is incomplete';
  END IF;
END $$;

WITH counts AS (
  SELECT
    setrow."id",
    COUNT(item."id")::integer AS target_count,
    COUNT(*) FILTER (WHERE item."targetType" = 'PRODUCT')::integer AS product_count,
    COUNT(*) FILTER (WHERE item."targetType" = 'VARIANT')::integer AS variant_count,
    COUNT(*) FILTER (WHERE item."targetType" = 'INVENTORY_ITEM')::integer AS inventory_count,
    COUNT(*) FILTER (WHERE item."targetType" = 'METAFIELD')::integer AS metafield_count,
    COUNT(*) FILTER (WHERE item."executionStatus" = 'PENDING')::integer AS pending_count,
    COUNT(*) FILTER (WHERE item."executionStatus" = 'SUBMITTED')::integer AS submitted_count,
    COUNT(*) FILTER (WHERE item."executionStatus" = 'SUCCEEDED')::integer AS succeeded_count,
    COUNT(*) FILTER (WHERE item."executionStatus" = 'FAILED')::integer AS failed_count,
    COUNT(*) FILTER (WHERE item."executionStatus" = 'SKIPPED')::integer AS skipped_count,
    COUNT(*) FILTER (WHERE item."verificationStatus" = 'PENDING')::integer AS verification_pending_count,
    COUNT(*) FILTER (WHERE item."verificationStatus" = 'SUCCEEDED')::integer AS verification_succeeded_count,
    COUNT(*) FILTER (WHERE item."verificationStatus" = 'FAILED')::integer AS verification_failed_count,
    COUNT(*) FILTER (WHERE item."undoStatus" = 'NOT_REQUIRED')::integer AS undo_not_required_count,
    COUNT(*) FILTER (WHERE item."undoStatus" = 'PENDING')::integer AS undo_pending_count,
    COUNT(*) FILTER (WHERE item."undoStatus" = 'SUBMITTED')::integer AS undo_submitted_count,
    COUNT(*) FILTER (WHERE item."undoStatus" = 'SUCCEEDED')::integer AS undo_succeeded_count,
    COUNT(*) FILTER (WHERE item."undoStatus" = 'FAILED')::integer AS undo_failed_count,
    COUNT(*) FILTER (WHERE item."undoStatus" = 'SKIPPED')::integer AS undo_skipped_count,
    md5(COALESCE(string_agg(item."targetKey", E'\n' ORDER BY item."targetKey"), '')) AS checksum
  FROM "TargetSnapshotSet" setrow
  JOIN (
    SELECT DISTINCT "shop", "ownerType" || ':' || "ownerId" AS "operationId"
    FROM "TargetSnapshot"
  ) affected
    ON affected."shop" = setrow."shop" AND affected."operationId" = setrow."operationId"
  LEFT JOIN "TargetSnapshotItem" item
    ON item."shop" = setrow."shop" AND item."snapshotSetId" = setrow."id"
  GROUP BY setrow."id"
)
UPDATE "TargetSnapshotSet" setrow
SET "targetCount" = counts.target_count,
    "productCount" = counts.product_count,
    "variantCount" = counts.variant_count,
    "inventoryItemCount" = counts.inventory_count,
    "metafieldCount" = counts.metafield_count,
    "pendingCount" = counts.pending_count,
    "submittedCount" = counts.submitted_count,
    "succeededCount" = counts.succeeded_count,
    "failedCount" = counts.failed_count,
    "skippedCount" = counts.skipped_count,
    "verificationPendingCount" = counts.verification_pending_count,
    "verifiedCount" = counts.verification_succeeded_count,
    "verificationFailedCount" = counts.verification_failed_count,
    "undoNotRequiredCount" = counts.undo_not_required_count,
    "undoPendingCount" = counts.undo_pending_count,
    "undoSubmittedCount" = counts.undo_submitted_count,
    "undoSucceededCount" = counts.undo_succeeded_count,
    "undoFailedCount" = counts.undo_failed_count,
    "undoSkippedCount" = counts.undo_skipped_count,
    "checksum" = counts.checksum,
    "status" = CASE
      WHEN setrow."status" = 'FREEZING'::"TargetSnapshotSetStatus"
        THEN 'FROZEN'::"TargetSnapshotSetStatus"
      ELSE setrow."status"
    END,
    "frozenAt" = COALESCE(setrow."frozenAt", CURRENT_TIMESTAMP)
FROM counts
WHERE setrow."id" = counts."id";

WITH ranked AS (
  SELECT
    "id",
    (ROW_NUMBER() OVER (
      PARTITION BY "snapshotSetId"
      ORDER BY "createdAt", "id"
    ) - 1)::integer AS ordinal
  FROM "TargetSnapshotItem"
)
UPDATE "TargetSnapshotItem" item
SET "ordinal" = ranked.ordinal
FROM ranked
WHERE item."id" = ranked."id" AND item."ordinal" IS NULL;

ALTER TABLE "TargetSnapshotItem" ALTER COLUMN "ordinal" SET NOT NULL;

CREATE INDEX "TargetSnapshotItem_shop_snapshotSetId_targetType_ordinal_id_idx"
  ON "TargetSnapshotItem" ("shop", "snapshotSetId", "targetType", "ordinal", "id");

DROP TABLE "TargetSnapshot";
