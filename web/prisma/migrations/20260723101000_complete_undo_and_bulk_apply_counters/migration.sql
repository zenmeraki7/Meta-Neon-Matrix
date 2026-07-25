-- Make child rows authoritative for both snapshot undo and bulk-apply progress.
ALTER TABLE "TargetSnapshotSet"
  ADD COLUMN "undoNotRequiredCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "undoSubmittedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "undoSkippedCount" INTEGER NOT NULL DEFAULT 0;

WITH counts AS (
  SELECT
    setrow."id" AS snapshot_set_id,
    COUNT(*) FILTER (WHERE item."undoStatus" = 'NOT_REQUIRED')::integer AS not_required_count,
    COUNT(*) FILTER (WHERE item."undoStatus" = 'PENDING')::integer AS pending_count,
    COUNT(*) FILTER (WHERE item."undoStatus" = 'SUBMITTED')::integer AS submitted_count,
    COUNT(*) FILTER (WHERE item."undoStatus" = 'SUCCEEDED')::integer AS succeeded_count,
    COUNT(*) FILTER (WHERE item."undoStatus" = 'FAILED')::integer AS failed_count,
    COUNT(*) FILTER (WHERE item."undoStatus" = 'SKIPPED')::integer AS skipped_count
  FROM "TargetSnapshotSet" setrow
  LEFT JOIN "TargetSnapshotItem" item
    ON item."shop" = setrow."shop" AND item."snapshotSetId" = setrow."id"
  GROUP BY setrow."id"
)
UPDATE "TargetSnapshotSet" setrow
SET "undoNotRequiredCount" = counts.not_required_count,
    "undoPendingCount" = counts.pending_count,
    "undoSubmittedCount" = counts.submitted_count,
    "undoSucceededCount" = counts.succeeded_count,
    "undoFailedCount" = counts.failed_count,
    "undoSkippedCount" = counts.skipped_count
FROM counts
WHERE counts.snapshot_set_id = setrow."id";

ALTER TABLE "TargetSnapshotSet"
  DROP CONSTRAINT IF EXISTS "TargetSnapshotSet_counter_state_check";

ALTER TABLE "TargetSnapshotSet" ADD CONSTRAINT "TargetSnapshotSet_counter_state_check" CHECK (
  "targetCount" >= 0 AND "productCount" >= 0 AND "variantCount" >= 0 AND
  "inventoryItemCount" >= 0 AND "metafieldCount" >= 0 AND
  "targetCount" = "productCount" + "variantCount" + "inventoryItemCount" + "metafieldCount" AND
  "pendingCount" >= 0 AND "submittedCount" >= 0 AND "succeededCount" >= 0 AND
  "failedCount" >= 0 AND "skippedCount" >= 0 AND
  "targetCount" = "pendingCount" + "submittedCount" + "succeededCount" + "failedCount" + "skippedCount" AND
  "verificationPendingCount" >= 0 AND "verifiedCount" >= 0 AND "verificationFailedCount" >= 0 AND
  "verificationPendingCount" + "verifiedCount" + "verificationFailedCount" <= "succeededCount" AND
  "undoNotRequiredCount" >= 0 AND "undoPendingCount" >= 0 AND "undoSubmittedCount" >= 0 AND
  "undoSucceededCount" >= 0 AND "undoFailedCount" >= 0 AND "undoSkippedCount" >= 0 AND
  "targetCount" = "undoNotRequiredCount" + "undoPendingCount" + "undoSubmittedCount" +
    "undoSucceededCount" + "undoFailedCount" + "undoSkippedCount"
) NOT VALID;

ALTER TABLE "TargetSnapshotSet"
  VALIDATE CONSTRAINT "TargetSnapshotSet_counter_state_check";

ALTER TABLE "BulkApplyRequest"
  ADD COLUMN "pendingItemCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "applyingItemCount" INTEGER NOT NULL DEFAULT 0;

WITH counts AS (
  SELECT
    request."id" AS request_id,
    COUNT(item."id")::integer AS eligible_count,
    COUNT(*) FILTER (WHERE item."status" = 'PENDING')::integer AS pending_count,
    COUNT(*) FILTER (WHERE item."status" = 'APPLYING')::integer AS applying_count,
    COUNT(*) FILTER (WHERE item."status" = 'APPLIED')::integer AS applied_count,
    COUNT(*) FILTER (WHERE item."status" IN ('FAILED', 'FAILED_PERMANENT'))::integer AS failed_count,
    COUNT(*) FILTER (WHERE item."status" = 'CANCELLED')::integer AS cancelled_count,
    COUNT(*) FILTER (WHERE item."status" = 'SKIPPED')::integer AS skipped_count
  FROM "BulkApplyRequest" request
  LEFT JOIN "BulkApplyItem" item
    ON item."shop" = request."shop" AND item."requestId" = request."id"
  GROUP BY request."id"
)
UPDATE "BulkApplyRequest" request
SET "totalCount" = counts.eligible_count,
    "pendingItemCount" = counts.pending_count,
    "applyingItemCount" = counts.applying_count,
    "appliedCount" = counts.applied_count,
    "failedCount" = counts.failed_count,
    "cancelledCount" = counts.cancelled_count,
    "skippedCount" = counts.skipped_count
FROM counts
WHERE counts.request_id = request."id";

ALTER TABLE "BulkApplyRequest"
  DROP CONSTRAINT IF EXISTS "BulkApplyRequest_counter_bounds_check";

ALTER TABLE "BulkApplyRequest" ADD CONSTRAINT "BulkApplyRequest_counter_state_check" CHECK (
  "totalCount" >= 0 AND "pendingItemCount" >= 0 AND "applyingItemCount" >= 0 AND
  "appliedCount" >= 0 AND "failedCount" >= 0 AND "cancelledCount" >= 0 AND "skippedCount" >= 0 AND
  "pendingItemCount" + "applyingItemCount" + "appliedCount" + "failedCount" +
    "cancelledCount" + "skippedCount" <= "totalCount" AND
  (
    "status" NOT IN ('COMPLETED', 'PARTIAL_FAILED', 'FAILED', 'CANCELLED') OR
    (
      "pendingItemCount" = 0 AND "applyingItemCount" = 0 AND
      "appliedCount" + "failedCount" + "cancelledCount" + "skippedCount" = "totalCount"
    )
  )
) NOT VALID;

ALTER TABLE "BulkApplyRequest"
  VALIDATE CONSTRAINT "BulkApplyRequest_counter_state_check";
