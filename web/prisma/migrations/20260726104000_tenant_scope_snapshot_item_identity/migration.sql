-- TargetSnapshotItem is merchant-owned. Build the tenant-explicit unique key
-- before removing the globally inferred form so reads and writes remain covered.
CREATE UNIQUE INDEX IF NOT EXISTS
  "TargetSnapshotItem_shop_snapshotSetId_targetKey_key"
  ON "TargetSnapshotItem" ("shop", "snapshotSetId", "targetKey");

DROP INDEX IF EXISTS
  "TargetSnapshotItem_snapshotSetId_targetKey_key";
