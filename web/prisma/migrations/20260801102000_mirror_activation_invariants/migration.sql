WITH ranked AS (
  SELECT batch."shop", batch."id", batch."resourceType",
    row_number() OVER (
      PARTITION BY batch."shop", batch."resourceType"
      ORDER BY
        CASE WHEN batch."id" IN (store."activeMirrorBatchId", store."activeCollectionBatchId") THEN 0 ELSE 1 END,
        batch."finalizedAt" DESC NULLS LAST, batch."createdAt" DESC, batch."id"
    ) AS active_rank
  FROM "MirrorBatch" batch
  JOIN "Store" store ON store."shopUrl" = batch."shop"
  WHERE batch."status" = 'ACTIVE'::"MirrorBatchStatus"
)
UPDATE "MirrorBatch" batch SET "status" = 'RETIRED'::"MirrorBatchStatus", "retiredAt" = NOW()
FROM ranked WHERE ranked.active_rank > 1 AND batch."shop" = ranked."shop" AND batch."id" = ranked."id";

UPDATE "Store" store SET "activeMirrorBatchId" = NULL, "repairRequired" = TRUE,
  "mirrorHealthState" = 'REPAIR_REQUIRED'::"MirrorHealthState"
WHERE store."activeMirrorBatchId" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM "MirrorBatch" batch WHERE batch."shop" = store."shopUrl"
  AND batch."id" = store."activeMirrorBatchId" AND batch."resourceType" = 'PRODUCT_CATALOG'::"MirrorResourceType"
  AND batch."status" = 'ACTIVE'::"MirrorBatchStatus"
);
UPDATE "Store" store SET "activeCollectionBatchId" = NULL, "repairRequired" = TRUE,
  "mirrorHealthState" = 'REPAIR_REQUIRED'::"MirrorHealthState"
WHERE store."activeCollectionBatchId" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM "MirrorBatch" batch WHERE batch."shop" = store."shopUrl"
  AND batch."id" = store."activeCollectionBatchId" AND batch."resourceType" = 'COLLECTION_CATALOG'::"MirrorResourceType"
  AND batch."status" = 'ACTIVE'::"MirrorBatchStatus"
);

CREATE OR REPLACE FUNCTION enforce_store_active_mirror_pointer() RETURNS trigger AS $$
BEGIN
  IF NEW."activeMirrorBatchId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "MirrorBatch" b WHERE b."shop" = NEW."shopUrl" AND b."id" = NEW."activeMirrorBatchId"
      AND b."resourceType" = 'PRODUCT_CATALOG'::"MirrorResourceType" AND b."status" = 'ACTIVE'::"MirrorBatchStatus"
  ) THEN RAISE EXCEPTION 'invalid active product mirror pointer'; END IF;
  IF NEW."activeCollectionBatchId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "MirrorBatch" b WHERE b."shop" = NEW."shopUrl" AND b."id" = NEW."activeCollectionBatchId"
      AND b."resourceType" = 'COLLECTION_CATALOG'::"MirrorResourceType" AND b."status" = 'ACTIVE'::"MirrorBatchStatus"
  ) THEN RAISE EXCEPTION 'invalid active collection mirror pointer'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "Store_active_mirror_pointer_check"
AFTER INSERT OR UPDATE OF "activeMirrorBatchId", "activeCollectionBatchId" ON "Store"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_store_active_mirror_pointer();

CREATE OR REPLACE FUNCTION enforce_mirror_batch_active_pointer() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Store" store
    WHERE store."shopUrl" = NEW."shop" AND (
      (store."activeMirrorBatchId" = NEW."id" AND (NEW."resourceType" <> 'PRODUCT_CATALOG'::"MirrorResourceType" OR NEW."status" <> 'ACTIVE'::"MirrorBatchStatus"))
      OR (store."activeCollectionBatchId" = NEW."id" AND (NEW."resourceType" <> 'COLLECTION_CATALOG'::"MirrorResourceType" OR NEW."status" <> 'ACTIVE'::"MirrorBatchStatus"))
    )
  ) THEN RAISE EXCEPTION 'active mirror batch cannot violate store pointer semantics'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "MirrorBatch_active_pointer_check"
AFTER UPDATE OF "status", "resourceType", "shop" ON "MirrorBatch"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_mirror_batch_active_pointer();
