-- The authoritative bulk-edit path is EditHistory -> TargetSnapshotSet ->
-- TargetSnapshotItem. Abort if the retired pipeline still has live work.
DO $$
BEGIN
  IF to_regclass('public."BulkApplyRequest"') IS NOT NULL AND EXISTS (
    SELECT 1
    FROM "BulkApplyRequest"
    WHERE "status"::text IN ('QUEUED', 'RUNNING')
  ) THEN
    RAISE EXCEPTION
      'Legacy BulkApplyRequest contains non-terminal work; drain or cancel it before retirement';
  END IF;
END $$;

DROP TABLE IF EXISTS "ProductApplySnapshot";
DROP TABLE IF EXISTS "BulkApplyItem";
DROP TABLE IF EXISTS "BulkApplyRequest";

DROP TYPE IF EXISTS "BulkApplyItemStatus";
DROP TYPE IF EXISTS "BulkApplyRequestStatus";
