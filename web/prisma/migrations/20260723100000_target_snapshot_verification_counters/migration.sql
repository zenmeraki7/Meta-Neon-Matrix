-- Separate mutation and verification state while preserving the existing
-- physical mutation-counter columns for a zero-copy Prisma logical rename.
CREATE TYPE "TargetSnapshotItemVerificationStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

ALTER TABLE "TargetSnapshotItem"
  ADD COLUMN "verificationStatus" "TargetSnapshotItemVerificationStatus";

ALTER TABLE "TargetSnapshotSet"
  ADD COLUMN "inventoryItemCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "metafieldCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "verificationPendingCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "verificationFailedCount" INTEGER NOT NULL DEFAULT 0;

-- VERIFIED was an execution bucket. Preserve its meaning in the new
-- verification machine, then collapse mutation execution back to SUCCEEDED.
UPDATE "TargetSnapshotItem"
SET "verificationStatus" = 'SUCCEEDED'
WHERE "executionStatus" = 'VERIFIED';

UPDATE "TargetSnapshotItem"
SET "verificationStatus" = 'PENDING'
WHERE "executionStatus" = 'SUCCEEDED' AND "verificationStatus" IS NULL;

CREATE TYPE "TargetSnapshotItemExecutionStatus_v2" AS ENUM
  ('PENDING', 'SUBMITTED', 'SUCCEEDED', 'FAILED', 'SKIPPED');

ALTER TABLE "TargetSnapshotItem"
  ALTER COLUMN "executionStatus" DROP DEFAULT,
  ALTER COLUMN "executionStatus" TYPE "TargetSnapshotItemExecutionStatus_v2"
    USING (CASE WHEN "executionStatus"::text = 'VERIFIED' THEN 'SUCCEEDED' ELSE "executionStatus"::text END)::"TargetSnapshotItemExecutionStatus_v2",
  ALTER COLUMN "executionStatus" SET DEFAULT 'PENDING'::"TargetSnapshotItemExecutionStatus_v2";

DROP TYPE "TargetSnapshotItemExecutionStatus";
ALTER TYPE "TargetSnapshotItemExecutionStatus_v2" RENAME TO "TargetSnapshotItemExecutionStatus";

DROP INDEX IF EXISTS "TargetSnapshotItem_shop_snapshotSetId_verificationStatus_idx";
CREATE INDEX "TargetSnapshotItem_shop_snapshotSetId_verificationStatus_idx"
  ON "TargetSnapshotItem" ("shop", "snapshotSetId", "verificationStatus");

WITH counts AS (
  SELECT
    setrow."id" AS "snapshotSetId",
    COUNT(item."id")::integer AS target_count,
    COUNT(*) FILTER (WHERE item."targetType" = 'PRODUCT')::integer AS product_count,
    COUNT(*) FILTER (WHERE item."targetType" = 'VARIANT')::integer AS variant_count,
    COUNT(*) FILTER (WHERE item."targetType" = 'INVENTORY_ITEM')::integer AS inventory_item_count,
    COUNT(*) FILTER (WHERE item."targetType" = 'METAFIELD')::integer AS metafield_count,
    COUNT(*) FILTER (WHERE item."executionStatus" = 'PENDING')::integer AS mutation_pending_count,
    COUNT(*) FILTER (WHERE item."executionStatus" = 'SUBMITTED')::integer AS mutation_submitted_count,
    COUNT(*) FILTER (WHERE item."executionStatus" = 'SUCCEEDED')::integer AS mutation_succeeded_count,
    COUNT(*) FILTER (WHERE item."executionStatus" = 'FAILED')::integer AS mutation_failed_count,
    COUNT(*) FILTER (WHERE item."executionStatus" = 'SKIPPED')::integer AS mutation_skipped_count,
    COUNT(*) FILTER (WHERE item."verificationStatus" = 'PENDING')::integer AS verification_pending_count,
    COUNT(*) FILTER (WHERE item."verificationStatus" = 'SUCCEEDED')::integer AS verification_succeeded_count,
    COUNT(*) FILTER (WHERE item."verificationStatus" = 'FAILED')::integer AS verification_failed_count,
    COUNT(*) FILTER (WHERE item."undoStatus" = 'PENDING')::integer AS undo_pending_count,
    COUNT(*) FILTER (WHERE item."undoStatus" = 'SUCCEEDED')::integer AS undo_succeeded_count,
    COUNT(*) FILTER (WHERE item."undoStatus" = 'FAILED')::integer AS undo_failed_count
  FROM "TargetSnapshotSet" setrow
  LEFT JOIN "TargetSnapshotItem" item
    ON item."shop" = setrow."shop" AND item."snapshotSetId" = setrow."id"
  GROUP BY setrow."id"
)
UPDATE "TargetSnapshotSet" setrow
SET "targetCount" = counts.target_count,
    "productCount" = counts.product_count,
    "variantCount" = counts.variant_count,
    "inventoryItemCount" = counts.inventory_item_count,
    "metafieldCount" = counts.metafield_count,
    "pendingCount" = counts.mutation_pending_count,
    "submittedCount" = counts.mutation_submitted_count,
    "succeededCount" = counts.mutation_succeeded_count,
    "failedCount" = counts.mutation_failed_count,
    "skippedCount" = counts.mutation_skipped_count,
    "verificationPendingCount" = counts.verification_pending_count,
    "verifiedCount" = counts.verification_succeeded_count,
    "verificationFailedCount" = counts.verification_failed_count,
    "undoPendingCount" = counts.undo_pending_count,
    "undoSucceededCount" = counts.undo_succeeded_count,
    "undoFailedCount" = counts.undo_failed_count
FROM counts WHERE counts."snapshotSetId" = setrow."id";

ALTER TABLE "TargetSnapshotSet"
  DROP CONSTRAINT IF EXISTS "TargetSnapshotSet_counter_bounds_check";

ALTER TABLE "TargetSnapshotSet" ADD CONSTRAINT "TargetSnapshotSet_counter_state_check" CHECK (
  "targetCount" >= 0 AND "productCount" >= 0 AND "variantCount" >= 0 AND
  "inventoryItemCount" >= 0 AND "metafieldCount" >= 0 AND
  "targetCount" = "productCount" + "variantCount" + "inventoryItemCount" + "metafieldCount" AND
  "pendingCount" >= 0 AND "submittedCount" >= 0 AND "succeededCount" >= 0 AND
  "failedCount" >= 0 AND "skippedCount" >= 0 AND
  "targetCount" = "pendingCount" + "submittedCount" + "succeededCount" + "failedCount" + "skippedCount" AND
  "verificationPendingCount" >= 0 AND "verifiedCount" >= 0 AND "verificationFailedCount" >= 0 AND
  "verificationPendingCount" + "verifiedCount" + "verificationFailedCount" <= "succeededCount" AND
  "undoPendingCount" >= 0 AND "undoSucceededCount" >= 0 AND "undoFailedCount" >= 0 AND
  "undoPendingCount" + "undoSucceededCount" + "undoFailedCount" <= "succeededCount"
) NOT VALID;

ALTER TABLE "TargetSnapshotSet"
  VALIDATE CONSTRAINT "TargetSnapshotSet_counter_state_check";
