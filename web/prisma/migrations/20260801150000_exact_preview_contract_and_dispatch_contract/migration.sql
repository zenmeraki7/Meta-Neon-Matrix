-- Authoritative preview lifecycle. Historical string references are deliberately
-- backfilled as non-executable because the old schema did not retain approval proof.
CREATE TYPE "PreviewContractStatus" AS ENUM (
  'BUILDING', 'READY_FOR_REVIEW', 'APPROVED', 'EXECUTION_CREATED',
  'EXECUTING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED',
  'EXPIRED', 'CORRUPTED', 'LEGACY_UNTRUSTED'
);

CREATE TABLE "PreviewContract" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "status" "PreviewContractStatus" NOT NULL DEFAULT 'BUILDING',
  "stateVersion" INTEGER NOT NULL DEFAULT 0,
  "contractHash" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "mirrorBatchId" TEXT NOT NULL,
  "snapshotSetId" TEXT NOT NULL,
  "approvedAt" TIMESTAMP(3),
  "approvedByActorId" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "executionId" TEXT,
  "executedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PreviewContract_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PreviewContract_revision_ck" CHECK ("revision" > 0),
  CONSTRAINT "PreviewContract_stateVersion_ck" CHECK ("stateVersion" >= 0),
  CONSTRAINT "PreviewContract_approval_ck" CHECK (
    ("approvedAt" IS NULL AND "approvedByActorId" IS NULL)
    OR ("approvedAt" IS NOT NULL AND "approvedByActorId" IS NOT NULL)
  ),
  CONSTRAINT "PreviewContract_execution_ck" CHECK (
    ("executionId" IS NULL AND "executedAt" IS NULL) OR "executionId" IS NOT NULL
  )
);

CREATE UNIQUE INDEX "PreviewContract_shop_id_key"
  ON "PreviewContract" ("shop", "id");
CREATE UNIQUE INDEX "PreviewContract_shop_contractHash_key"
  ON "PreviewContract" ("shop", "contractHash");
CREATE UNIQUE INDEX "PreviewContract_shop_snapshotSetId_revision_key"
  ON "PreviewContract" ("shop", "snapshotSetId", "revision");
CREATE INDEX "PreviewContract_shop_status_expiresAt_idx"
  ON "PreviewContract" ("shop", "status", "expiresAt");

INSERT INTO "PreviewContract" (
  "id", "shop", "revision", "status", "stateVersion", "contractHash",
  "payloadHash", "mirrorBatchId", "snapshotSetId", "expiresAt", "createdAt", "updatedAt"
)
SELECT
  'legacy_' || md5(snapshot."shop" || ':' || snapshot."id"),
  snapshot."shop", 1, 'LEGACY_UNTRUSTED'::"PreviewContractStatus", 0,
  md5('legacy-contract:' || snapshot."shop" || ':' || snapshot."id") ||
    md5('legacy-contract-2:' || snapshot."shop" || ':' || snapshot."id"),
  md5('legacy-payload:' || snapshot."shop" || ':' || snapshot."id" || ':' || COALESCE(snapshot."checksum", '')) ||
    md5('legacy-payload-2:' || snapshot."shop" || ':' || snapshot."id" || ':' || COALESCE(snapshot."checksum", '')),
  snapshot."mirrorBatchId", snapshot."id",
  COALESCE(snapshot."expiresAt", snapshot."createdAt" + INTERVAL '30 days'),
  snapshot."createdAt", CURRENT_TIMESTAMP
FROM "TargetSnapshotSet" snapshot;

ALTER TABLE "PreviewContract" ADD CONSTRAINT "PreviewContract_snapshotSet_fkey"
  FOREIGN KEY ("shop", "snapshotSetId") REFERENCES "TargetSnapshotSet" ("shop", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "PreviewContract" VALIDATE CONSTRAINT "PreviewContract_snapshotSet_fkey";

CREATE FUNCTION prevent_preview_contract_authority_update() RETURNS trigger AS $$
BEGIN
  IF NEW."shop" IS DISTINCT FROM OLD."shop"
     OR NEW."revision" IS DISTINCT FROM OLD."revision"
     OR NEW."contractHash" IS DISTINCT FROM OLD."contractHash"
     OR NEW."payloadHash" IS DISTINCT FROM OLD."payloadHash"
     OR NEW."mirrorBatchId" IS DISTINCT FROM OLD."mirrorBatchId"
     OR NEW."snapshotSetId" IS DISTINCT FROM OLD."snapshotSetId"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN
    RAISE EXCEPTION 'PREVIEW_CONTRACT_AUTHORITY_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "PreviewContract_authority_immutable_trg"
  BEFORE UPDATE ON "PreviewContract"
  FOR EACH ROW EXECUTE FUNCTION prevent_preview_contract_authority_update();

DROP INDEX IF EXISTS "TargetSnapshotSet_shop_previewContractId_idx";
ALTER TABLE "TargetSnapshotSet" DROP COLUMN "previewContractId";
ALTER TABLE "TargetSnapshotSet" DROP CONSTRAINT IF EXISTS "TargetSnapshotSet_shop_mirrorBatchId_fkey";
ALTER TABLE "TargetSnapshotSet" ADD CONSTRAINT "TargetSnapshotSet_shop_mirrorBatchId_fkey"
  FOREIGN KEY ("shop", "mirrorBatchId") REFERENCES "MirrorBatch" ("shop", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "TargetSnapshotSet" VALIDATE CONSTRAINT "TargetSnapshotSet_shop_mirrorBatchId_fkey";

-- The item belongs to the tenant-safe snapshot set. mirrorBatchId remains data
-- covered by the set/item integrity checks, not part of the ownership identity.
ALTER TABLE "TargetSnapshotItem"
  DROP CONSTRAINT IF EXISTS "TargetSnapshotItem_shop_snapshotSetId_mirrorBatchId_fkey";
ALTER TABLE "TargetSnapshotItem" ADD CONSTRAINT "TargetSnapshotItem_shop_snapshotSetId_fkey"
  FOREIGN KEY ("shop", "snapshotSetId") REFERENCES "TargetSnapshotSet" ("shop", "id")
  ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "TargetSnapshotItem" VALIDATE CONSTRAINT "TargetSnapshotItem_shop_snapshotSetId_fkey";
DROP INDEX IF EXISTS "TargetSnapshotSet_shop_id_mirrorBatchId_key";

UPDATE "TargetSnapshotSet" snapshot
SET "status" = 'CORRUPTED'::"TargetSnapshotSetStatus",
    "freezeErrorCode" = 'UNPROVABLE_VALUE_HASH',
    "freezeErrorMessage" = 'One or more historical target values could not be canonically reconstructed'
WHERE EXISTS (
  SELECT 1 FROM "TargetSnapshotItem" item
  WHERE item."shop" = snapshot."shop" AND item."snapshotSetId" = snapshot."id"
    AND (item."beforeValueHash" IS NULL OR item."plannedValueHash" IS NULL)
);
INSERT INTO "TargetSnapshotItemQuarantine" (
  "shop", "snapshotSetId", "targetSnapshotItemId", "reason", "rowJson"
)
SELECT item."shop", item."snapshotSetId", item."id", 'UNPROVABLE_VALUE_HASH', to_jsonb(item)
FROM "TargetSnapshotItem" item
WHERE item."beforeValueHash" IS NULL OR item."plannedValueHash" IS NULL
ON CONFLICT ("shop", "snapshotSetId", "targetSnapshotItemId") DO NOTHING;
DELETE FROM "TargetSnapshotItem"
WHERE "beforeValueHash" IS NULL OR "plannedValueHash" IS NULL;
ALTER TABLE "TargetSnapshotItem" ALTER COLUMN "beforeValueHash" SET NOT NULL;
ALTER TABLE "TargetSnapshotItem" ALTER COLUMN "plannedValueHash" SET NOT NULL;
ALTER TABLE "TargetSnapshotItem" DROP CONSTRAINT "TargetSnapshotItem_pkey";
ALTER TABLE "TargetSnapshotItem" ADD CONSTRAINT "TargetSnapshotItem_pkey" PRIMARY KEY ("shop", "id");
ALTER TABLE "TargetSnapshotItem" ADD CONSTRAINT "TargetSnapshotItem_identity_ck" CHECK (
  ("targetType" = 'PRODUCT' AND "productId" IS NOT NULL AND "variantId" IS NULL AND "inventoryItemId" IS NULL AND "locationId" IS NULL)
  OR ("targetType" = 'VARIANT' AND "productId" IS NOT NULL AND "variantId" IS NOT NULL AND "inventoryItemId" IS NULL AND "locationId" IS NULL)
  OR ("targetType" = 'INVENTORY_ITEM' AND "productId" IS NOT NULL AND "variantId" IS NOT NULL AND "inventoryItemId" IS NOT NULL)
  OR ("targetType" = 'METAFIELD' AND "metafieldOwnerType" IS NOT NULL AND "metafieldNamespace" IS NOT NULL AND "metafieldKey" IS NOT NULL)
  OR ("targetType" = 'PRODUCT_OPTION' AND "productId" IS NOT NULL AND "productOptionPosition" BETWEEN 1 AND 3)
  OR ("targetType" = 'COLLECTION_MEMBERSHIP' AND "productId" IS NOT NULL AND "collectionId" IS NOT NULL)
  OR ("targetType" = 'INVENTORY_LEVEL' AND "productId" IS NOT NULL AND "variantId" IS NOT NULL AND "inventoryItemId" IS NOT NULL AND "locationId" IS NOT NULL)
) NOT VALID;
ALTER TABLE "TargetSnapshotItem" VALIDATE CONSTRAINT "TargetSnapshotItem_identity_ck";

-- Refresh projections from source-of-truth item states before enforcing totals.
WITH counts AS (
  SELECT "shop", "snapshotSetId", count(*)::integer AS total,
    count(*) FILTER (WHERE "executionStatus" IN ('PENDING','DEFERRED'))::integer AS pending,
    count(*) FILTER (WHERE "executionStatus" = 'SUBMITTED')::integer AS submitted,
    count(*) FILTER (WHERE "executionStatus" = 'SUCCEEDED')::integer AS succeeded,
    count(*) FILTER (WHERE "executionStatus" = 'FAILED')::integer AS failed,
    count(*) FILTER (WHERE "executionStatus" IN ('SKIPPED','CANCELLED'))::integer AS skipped
  FROM "TargetSnapshotItem" GROUP BY "shop", "snapshotSetId"
)
UPDATE "TargetSnapshotSet" snapshot SET
  "targetCount" = counts.total, "pendingCount" = counts.pending,
  "submittedCount" = counts.submitted, "succeededCount" = counts.succeeded,
  "failedCount" = counts.failed, "skippedCount" = counts.skipped
FROM counts WHERE snapshot."shop" = counts."shop" AND snapshot."id" = counts."snapshotSetId";
UPDATE "TargetSnapshotSet" snapshot SET
  "targetCount" = 0, "pendingCount" = 0, "submittedCount" = 0,
  "succeededCount" = 0, "failedCount" = 0, "skippedCount" = 0
WHERE NOT EXISTS (
  SELECT 1 FROM "TargetSnapshotItem" item
  WHERE item."shop" = snapshot."shop" AND item."snapshotSetId" = snapshot."id"
);
ALTER TABLE "TargetSnapshotSet" ADD CONSTRAINT "TargetSnapshotSet_counts_nonnegative_ck" CHECK (
  "targetCount" >= 0 AND "productCount" >= 0 AND "variantCount" >= 0
  AND "inventoryItemCount" >= 0 AND "metafieldCount" >= 0
  AND "productOptionCount" >= 0 AND "collectionMembershipCount" >= 0
  AND "inventoryLevelCount" >= 0 AND "pendingCount" >= 0
  AND "submittedCount" >= 0 AND "succeededCount" >= 0
  AND "failedCount" >= 0 AND "skippedCount" >= 0
) NOT VALID;
ALTER TABLE "TargetSnapshotSet" ADD CONSTRAINT "TargetSnapshotSet_execution_total_ck" CHECK (
  "targetCount" = "pendingCount" + "submittedCount" + "succeededCount" + "failedCount" + "skippedCount"
) NOT VALID;
ALTER TABLE "TargetSnapshotSet" VALIDATE CONSTRAINT "TargetSnapshotSet_counts_nonnegative_ck";
ALTER TABLE "TargetSnapshotSet" VALIDATE CONSTRAINT "TargetSnapshotSet_execution_total_ck";

-- Exact dispatch lease/fencing names. Existing DISPATCHING work is made stale
-- and safely reclaimable by token-aware workers.
ALTER TABLE "OperationEnqueueIntent" RENAME COLUMN "claimToken" TO "dispatchClaimToken";
ALTER TABLE "OperationEnqueueIntent" RENAME COLUMN "fencingToken" TO "dispatchFencingToken";
ALTER TABLE "OperationEnqueueIntent"
  ADD COLUMN "dispatchLeaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "lastErrorCode" TEXT;
UPDATE "OperationEnqueueIntent" SET
  "dispatchLeaseExpiresAt" = COALESCE("dispatchHeartbeatAt", "dispatchStartedAt", "updatedAt")
WHERE "status" = 'DISPATCHING'::"OperationEnqueueIntentStatus";
ALTER TABLE "OperationEnqueueIntent" DROP COLUMN "runAt";

ALTER TABLE "UndoOperation"
  ADD COLUMN "previewContractId" TEXT,
  ADD COLUMN "executionId" TEXT;
UPDATE "UndoOperation" SET "idempotencyKeyHash" =
  md5('legacy-undo:' || "shop" || ':' || "id") || md5('legacy-undo-2:' || "shop" || ':' || "id")
WHERE "idempotencyKeyHash" IS NULL;
ALTER TABLE "UndoOperation" ALTER COLUMN "idempotencyKeyHash" SET NOT NULL;

ALTER TABLE "UsageReservation" DROP CONSTRAINT "UsageReservation_period_fkey";
ALTER TABLE "UsageReservation" RENAME COLUMN "usagePeriodId" TO "periodId";
ALTER TABLE "UsageReservation" RENAME COLUMN "idempotencyKey" TO "idempotencyKeyHash";
ALTER TABLE "UsageReservation" RENAME COLUMN "billingAuthorityVersion" TO "subscriptionVersion";
ALTER INDEX "UsageReservation_shop_idempotency_key" RENAME TO "UsageReservation_shop_idempotencyKeyHash_key";
DROP INDEX "UsageReservation_shop_period_idx";
CREATE INDEX "UsageReservation_shop_periodId_entitlementKey_status_idx"
  ON "UsageReservation" ("shop", "periodId", "entitlementKey", "status");
ALTER TABLE "UsageReservation" ADD CONSTRAINT "UsageReservation_period_fkey"
  FOREIGN KEY ("shop", "periodId") REFERENCES "UsagePeriod" ("shop", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "UsageReservation" VALIDATE CONSTRAINT "UsageReservation_period_fkey";

DROP INDEX IF EXISTS "Collection_shop_mirrorBatchId_shopifyId_idx";
DROP INDEX IF EXISTS "EditHistory_recurringEditId_idx";
DROP INDEX IF EXISTS "EditHistory_recurringRunId_idx";
DROP INDEX IF EXISTS "EditHistory_automaticProductRuleId_idx";
DROP INDEX IF EXISTS "EditHistory_automaticProductRuleRunId_idx";
CREATE INDEX "EditHistory_shop_recurringEditId_idx" ON "EditHistory" ("shop", "recurringEditId");
CREATE INDEX "EditHistory_shop_recurringRunId_idx" ON "EditHistory" ("shop", "recurringRunId");
CREATE INDEX "EditHistory_shop_automaticProductRuleId_idx" ON "EditHistory" ("shop", "automaticProductRuleId");
CREATE INDEX "EditHistory_shop_automaticProductRuleRunId_idx" ON "EditHistory" ("shop", "automaticProductRuleRunId");
