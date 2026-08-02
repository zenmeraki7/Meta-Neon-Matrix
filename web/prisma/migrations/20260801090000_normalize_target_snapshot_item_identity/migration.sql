ALTER TABLE "TargetSnapshotItem"
  ADD COLUMN "fieldPath" TEXT,
  ADD COLUMN "productOptionPosition" INTEGER,
  ADD COLUMN "metafieldOwnerId" TEXT,
  ADD COLUMN "metafieldOwnerType" TEXT,
  ADD COLUMN "metafieldNamespace" TEXT,
  ADD COLUMN "metafieldKey" TEXT,
  ADD COLUMN "beforeValueHash" TEXT,
  ADD COLUMN "plannedValueHash" TEXT,
  ADD COLUMN "writtenValueHash" TEXT,
  ADD COLUMN "sourceVersion" TEXT,
  ADD COLUMN "sourceUpdatedAt" TIMESTAMP(3);

ALTER TABLE "TargetSnapshotSet"
  ADD COLUMN "productOptionCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "collectionMembershipCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "inventoryLevelCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ChangeRecord" ADD COLUMN "fieldPath" TEXT;
UPDATE "ChangeRecord"
SET "fieldPath" = 'legacy.atomic.' || substr(md5(
  COALESCE("productFieldChanges"::text, '') || ':' || COALESCE("variantFieldChanges"::text, '')
), 1, 24);
ALTER TABLE "ChangeRecord" ALTER COLUMN "fieldPath" SET NOT NULL;
DROP INDEX IF EXISTS "uniq_change_record_shop_history_batch_target";
CREATE UNIQUE INDEX "uniq_change_record_shop_history_batch_target_field"
  ON "ChangeRecord" ("shop", "editHistoryId", "batchId", "targetIdentity", "fieldPath");

CREATE TABLE "TargetSnapshotItemQuarantine" (
  "shop" TEXT NOT NULL,
  "snapshotSetId" TEXT NOT NULL,
  "targetSnapshotItemId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "rowJson" JSONB NOT NULL,
  "quarantinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TargetSnapshotItemQuarantine_pkey"
    PRIMARY KEY ("shop", "snapshotSetId", "targetSnapshotItemId")
);

DROP INDEX IF EXISTS "TargetSnapshotItem_shop_snapshotSetId_targetKey_key";

-- Split non-atomic product field arrays into one immutable field row.
INSERT INTO "TargetSnapshotItem"
SELECT (
  jsonb_populate_record(
    NULL::"TargetSnapshotItem",
    to_jsonb(item) || jsonb_build_object(
      'id', item."id" || ':pf:' || md5(change.value->>'field' || ':' || change.ordinality::text),
      'targetType', 'PRODUCT',
      'variantId', NULL,
      'inventoryItemId', NULL,
      'locationId', NULL,
      'fieldPath', 'product.' || lower(regexp_replace(change.value->>'field', '[^a-zA-Z0-9]+', '_', 'g')),
      'plannedMutation', jsonb_set(
        jsonb_set(item."plannedMutation", '{productFieldChanges}', jsonb_build_array(change.value), true),
        '{variantFieldChanges}', '[]'::jsonb, true
      ),
      'beforeValueHash', md5(COALESCE((change.value->'oldValue')::text, 'null')),
      'plannedValueHash', md5(COALESCE((change.value->'newValue')::text, 'null')),
      'sourceVersion', 'legacy-split-json-v1'
    )
  )
).*
FROM "TargetSnapshotItem" item
CROSS JOIN LATERAL jsonb_array_elements(item."plannedMutation"->'productFieldChanges')
  WITH ORDINALITY AS change(value, ordinality)
WHERE item."mutationGroupKey" IS NULL
  AND jsonb_typeof(item."plannedMutation"->'productFieldChanges') = 'array'
  AND jsonb_array_length(item."plannedMutation"->'productFieldChanges') > 0
  AND (
    jsonb_array_length(item."plannedMutation"->'productFieldChanges') > 1
    OR (
      jsonb_typeof(item."plannedMutation"->'variantFieldChanges') = 'array'
      AND jsonb_array_length(item."plannedMutation"->'variantFieldChanges') > 0
    )
  );

-- Split non-atomic variant groups and their changes. The parent product identity
-- is retained and the exact variant identity comes from the planned group.
INSERT INTO "TargetSnapshotItem"
SELECT (
  jsonb_populate_record(
    NULL::"TargetSnapshotItem",
    to_jsonb(item) || jsonb_build_object(
      'id', item."id" || ':vf:' || md5(group_row.value->>'variantId' || ':' || change.value->>'field' || ':' || change.ordinality::text),
      'targetType', 'VARIANT',
      'variantId', group_row.value->>'variantId',
      'inventoryItemId', NULL,
      'locationId', NULL,
      'collectionId', NULL,
      'productOptionPosition', NULL,
      'fieldPath', 'variant.' || lower(regexp_replace(change.value->>'field', '[^a-zA-Z0-9]+', '_', 'g')),
      'plannedMutation', jsonb_set(
        jsonb_set(item."plannedMutation", '{productFieldChanges}', '[]'::jsonb, true),
        '{variantFieldChanges}',
        jsonb_build_array(group_row.value || jsonb_build_object('changes', jsonb_build_array(change.value))),
        true
      ),
      'beforeValueHash', md5(COALESCE((change.value->'oldValue')::text, 'null')),
      'plannedValueHash', md5(COALESCE((change.value->'newValue')::text, 'null')),
      'sourceVersion', 'legacy-split-json-v1'
    )
  )
).*
FROM "TargetSnapshotItem" item
CROSS JOIN LATERAL jsonb_array_elements(item."plannedMutation"->'variantFieldChanges')
  WITH ORDINALITY AS group_row(value, ordinality)
CROSS JOIN LATERAL jsonb_array_elements(
  CASE
    WHEN jsonb_typeof(group_row.value->'changes') = 'array' THEN group_row.value->'changes'
    ELSE jsonb_build_array(group_row.value)
  END
) WITH ORDINALITY AS change(value, ordinality)
WHERE item."mutationGroupKey" IS NULL
  AND jsonb_typeof(item."plannedMutation"->'variantFieldChanges') = 'array'
  AND (
    (jsonb_typeof(item."plannedMutation"->'productFieldChanges') = 'array'
      AND jsonb_array_length(item."plannedMutation"->'productFieldChanges') > 0)
    OR
    jsonb_array_length(item."plannedMutation"->'variantFieldChanges') > 1
    OR jsonb_array_length(
      CASE
        WHEN jsonb_typeof(group_row.value->'changes') = 'array' THEN group_row.value->'changes'
        ELSE jsonb_build_array(group_row.value)
      END
    ) > 1
  );

DELETE FROM "TargetSnapshotItem" item
WHERE item."mutationGroupKey" IS NULL
  AND (
    (jsonb_typeof(item."plannedMutation"->'productFieldChanges') = 'array'
      AND jsonb_array_length(item."plannedMutation"->'productFieldChanges') > 1)
    OR
    (jsonb_typeof(item."plannedMutation"->'variantFieldChanges') = 'array'
      AND jsonb_array_length(item."plannedMutation"->'variantFieldChanges') > 1)
    OR
    ((jsonb_typeof(item."plannedMutation"->'productFieldChanges') = 'array'
      AND jsonb_array_length(item."plannedMutation"->'productFieldChanges') > 0)
     AND
     (jsonb_typeof(item."plannedMutation"->'variantFieldChanges') = 'array'
      AND jsonb_array_length(item."plannedMutation"->'variantFieldChanges') > 0))
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(item."plannedMutation"->'variantFieldChanges') = 'array'
            THEN item."plannedMutation"->'variantFieldChanges'
          ELSE '[]'::jsonb
        END
      ) group_row(value)
      WHERE jsonb_typeof(group_row.value->'changes') = 'array'
        AND jsonb_array_length(group_row.value->'changes') > 1
    )
  )
  AND item."sourceVersion" IS NULL;

-- Normalize single-field and explicitly atomic historical rows.
UPDATE "TargetSnapshotItem" item
SET "fieldPath" = COALESCE(
      item."fieldPath",
      CASE
        WHEN item."targetType"::text = 'METAFIELD' THEN
          'metafield.' || COALESCE(item."plannedMutation"->'metafield'->>'namespace', item."plannedMutation"->'metafieldsSetInput'->>'namespace')
          || '.' || COALESCE(item."plannedMutation"->'metafield'->>'key', item."plannedMutation"->'metafieldsSetInput'->>'key')
        WHEN item."mutationGroupKey" IS NOT NULL THEN
          'atomic.' || lower(item."targetType"::text) || '.' || substr(md5(item."plannedMutation"::text), 1, 24)
        WHEN jsonb_typeof(item."plannedMutation"->'productFieldChanges') = 'array'
          AND jsonb_array_length(item."plannedMutation"->'productFieldChanges') = 1 THEN
          'product.' || lower(regexp_replace(item."plannedMutation"->'productFieldChanges'->0->>'field', '[^a-zA-Z0-9]+', '_', 'g'))
        WHEN jsonb_typeof(item."plannedMutation"->'variantFieldChanges') = 'array'
          AND jsonb_array_length(item."plannedMutation"->'variantFieldChanges') = 1 THEN
          'variant.' || lower(regexp_replace(
            COALESCE(
              item."plannedMutation"->'variantFieldChanges'->0->'changes'->0->>'field',
              item."plannedMutation"->'variantFieldChanges'->0->>'field'
            ),
            '[^a-zA-Z0-9]+', '_', 'g'
          ))
        ELSE NULL
      END
    ),
    "metafieldOwnerId" = CASE WHEN item."targetType"::text = 'METAFIELD' THEN
      COALESCE(item."plannedMutation"->'metafield'->>'ownerId', item."plannedMutation"->'metafieldsSetInput'->>'ownerId', item."variantId", item."productId")
      ELSE item."metafieldOwnerId" END,
    "metafieldOwnerType" = CASE WHEN item."targetType"::text = 'METAFIELD' THEN
      upper(COALESCE(item."plannedMutation"->'metafield'->>'ownerType', item."plannedMutation"->'metafieldsSetInput'->>'ownerType', CASE WHEN item."variantId" IS NOT NULL THEN 'VARIANT' ELSE 'PRODUCT' END))
      ELSE item."metafieldOwnerType" END,
    "metafieldNamespace" = CASE WHEN item."targetType"::text = 'METAFIELD' THEN
      COALESCE(item."plannedMutation"->'metafield'->>'namespace', item."plannedMutation"->'metafieldsSetInput'->>'namespace')
      ELSE item."metafieldNamespace" END,
    "metafieldKey" = CASE WHEN item."targetType"::text = 'METAFIELD' THEN
      COALESCE(item."plannedMutation"->'metafield'->>'key', item."plannedMutation"->'metafieldsSetInput'->>'key')
      ELSE item."metafieldKey" END,
    "beforeValueHash" = COALESCE(item."beforeValueHash", md5(
      CASE
        WHEN jsonb_typeof(item."plannedMutation"->'productFieldChanges') = 'array'
          AND jsonb_array_length(item."plannedMutation"->'productFieldChanges') = 1
          THEN COALESCE((item."plannedMutation"->'productFieldChanges'->0->'oldValue')::text, 'null')
        WHEN jsonb_typeof(item."plannedMutation"->'variantFieldChanges') = 'array'
          AND jsonb_array_length(item."plannedMutation"->'variantFieldChanges') = 1
          THEN COALESCE((item."plannedMutation"->'variantFieldChanges'->0->'changes'->0->'oldValue')::text, 'null')
        ELSE item."beforeValues"::text
      END
    )),
    "plannedValueHash" = COALESCE(item."plannedValueHash", md5(
      CASE
        WHEN jsonb_typeof(item."plannedMutation"->'productFieldChanges') = 'array'
          AND jsonb_array_length(item."plannedMutation"->'productFieldChanges') = 1
          THEN COALESCE((item."plannedMutation"->'productFieldChanges'->0->'newValue')::text, 'null')
        WHEN jsonb_typeof(item."plannedMutation"->'variantFieldChanges') = 'array'
          AND jsonb_array_length(item."plannedMutation"->'variantFieldChanges') = 1
          THEN COALESCE((item."plannedMutation"->'variantFieldChanges'->0->'changes'->0->'newValue')::text, 'null')
        ELSE item."plannedMutation"::text
      END
    )),
    "sourceVersion" = COALESCE(item."sourceVersion", 'legacy-md5-json-v1');

UPDATE "TargetSnapshotItem"
SET "writtenValueHash" = "plannedValueHash"
WHERE "executionStatus"::text = 'SUCCEEDED'
  AND "writtenValueHash" IS NULL;

UPDATE "TargetSnapshotItem"
SET "targetType" = 'PRODUCT_OPTION'::"TargetSnapshotTargetType",
    "productOptionPosition" = substring("fieldPath" FROM 'option([123])')::integer
WHERE "fieldPath" ~ '^product\.option[123](name|values)$'
  AND "productId" IS NOT NULL;

UPDATE "TargetSnapshotItem"
SET "targetType" = 'COLLECTION_MEMBERSHIP'::"TargetSnapshotTargetType"
WHERE "fieldPath" IN ('product.collections', 'collection_membership.collections')
  AND "productId" IS NOT NULL
  AND "collectionId" IS NOT NULL;

UPDATE "TargetSnapshotItem"
SET "targetType" = 'INVENTORY_LEVEL'::"TargetSnapshotTargetType"
WHERE "fieldPath" ~ '(inventory|inventoryquantity|available)$'
  AND "productId" IS NOT NULL
  AND "variantId" IS NOT NULL
  AND "inventoryItemId" IS NOT NULL
  AND "locationId" IS NOT NULL;

-- Rebuild target keys from normalized server-owned identities.
UPDATE "TargetSnapshotItem" item
SET "targetKey" = CASE item."targetType"::text
  WHEN 'PRODUCT' THEN 'PRODUCT:' || item."productId"
  WHEN 'VARIANT' THEN 'VARIANT:' || item."productId" || ':' || item."variantId"
  WHEN 'INVENTORY_ITEM' THEN 'INVENTORY_ITEM:' || item."productId" || ':' || item."variantId" || ':' || item."inventoryItemId"
  WHEN 'INVENTORY_LEVEL' THEN 'INVENTORY_LEVEL:' || item."inventoryItemId" || ':' || item."locationId"
  WHEN 'PRODUCT_OPTION' THEN 'PRODUCT_OPTION:' || item."productId" || ':' || item."productOptionPosition"::text
  WHEN 'COLLECTION_MEMBERSHIP' THEN 'COLLECTION_MEMBERSHIP:' || item."productId" || ':' || item."collectionId"
  WHEN 'METAFIELD' THEN 'METAFIELD:' || item."metafieldOwnerType" || ':' || item."metafieldOwnerId" || ':' || item."metafieldNamespace" || ':' || item."metafieldKey"
END;

-- Quarantine impossible identities or fields and corrupt their parent sets so
-- neither legacy nor dual-read execution can claim them.
INSERT INTO "TargetSnapshotItemQuarantine" (
  "shop", "snapshotSetId", "targetSnapshotItemId", "reason", "rowJson"
)
SELECT item."shop", item."snapshotSetId", item."id",
  CASE
    WHEN item."fieldPath" IS NULL OR btrim(item."fieldPath") = '' THEN 'FIELD_PATH_UNPROVABLE'
    ELSE 'IDENTITY_COMBINATION_INVALID'
  END,
  to_jsonb(item)
FROM "TargetSnapshotItem" item
WHERE item."fieldPath" IS NULL OR btrim(item."fieldPath") = ''
   OR NOT (
     (item."targetType"::text = 'PRODUCT' AND item."productId" IS NOT NULL AND num_nonnulls(item."variantId", item."inventoryItemId", item."locationId", item."collectionId", item."productOptionPosition", item."metafieldOwnerId", item."metafieldOwnerType", item."metafieldNamespace", item."metafieldKey") = 0)
     OR (item."targetType"::text = 'VARIANT' AND item."productId" IS NOT NULL AND item."variantId" IS NOT NULL AND num_nonnulls(item."inventoryItemId", item."locationId", item."collectionId", item."productOptionPosition", item."metafieldOwnerId", item."metafieldOwnerType", item."metafieldNamespace", item."metafieldKey") = 0)
     OR (item."targetType"::text = 'INVENTORY_ITEM' AND item."productId" IS NOT NULL AND item."variantId" IS NOT NULL AND item."inventoryItemId" IS NOT NULL AND num_nonnulls(item."locationId", item."collectionId", item."productOptionPosition", item."metafieldOwnerId", item."metafieldOwnerType", item."metafieldNamespace", item."metafieldKey") = 0)
     OR (item."targetType"::text = 'INVENTORY_LEVEL' AND item."productId" IS NOT NULL AND item."variantId" IS NOT NULL AND item."inventoryItemId" IS NOT NULL AND item."locationId" IS NOT NULL AND num_nonnulls(item."collectionId", item."productOptionPosition", item."metafieldOwnerId", item."metafieldOwnerType", item."metafieldNamespace", item."metafieldKey") = 0)
     OR (item."targetType"::text = 'PRODUCT_OPTION' AND item."productId" IS NOT NULL AND item."productOptionPosition" BETWEEN 1 AND 3 AND num_nonnulls(item."variantId", item."inventoryItemId", item."locationId", item."collectionId", item."metafieldOwnerId", item."metafieldOwnerType", item."metafieldNamespace", item."metafieldKey") = 0)
     OR (item."targetType"::text = 'COLLECTION_MEMBERSHIP' AND item."productId" IS NOT NULL AND item."collectionId" IS NOT NULL AND num_nonnulls(item."variantId", item."inventoryItemId", item."locationId", item."productOptionPosition", item."metafieldOwnerId", item."metafieldOwnerType", item."metafieldNamespace", item."metafieldKey") = 0)
     OR (item."targetType"::text = 'METAFIELD' AND item."metafieldOwnerId" IS NOT NULL AND item."metafieldOwnerType" IS NOT NULL AND item."metafieldNamespace" IS NOT NULL AND item."metafieldKey" IS NOT NULL AND num_nonnulls(item."productId", item."variantId", item."inventoryItemId", item."locationId", item."collectionId", item."productOptionPosition") = 0)
   );

INSERT INTO "TargetSnapshotItemQuarantine" (
  "shop", "snapshotSetId", "targetSnapshotItemId", "reason", "rowJson"
)
SELECT item."shop", item."snapshotSetId", item."id",
  'FIELD_TARGET_FAMILY_INVALID', to_jsonb(item)
FROM "TargetSnapshotItem" item
WHERE NOT (
  (item."targetType"::text = 'PRODUCT' AND (item."fieldPath" LIKE 'product.%' OR item."fieldPath" LIKE 'atomic.product.%'))
  OR (item."targetType"::text = 'VARIANT' AND (item."fieldPath" LIKE 'variant.%' OR item."fieldPath" LIKE 'atomic.variant.%'))
  OR (item."targetType"::text = 'INVENTORY_ITEM' AND (item."fieldPath" LIKE 'inventory_item.%' OR item."fieldPath" LIKE 'atomic.inventory_item.%'))
  OR (item."targetType"::text = 'INVENTORY_LEVEL' AND (item."fieldPath" LIKE 'inventory_level.%' OR item."fieldPath" LIKE 'atomic.inventory_level.%'))
  OR (item."targetType"::text = 'PRODUCT_OPTION' AND (item."fieldPath" LIKE 'product_option.%' OR item."fieldPath" LIKE 'atomic.product_option.%' OR item."fieldPath" ~ '^product\.option[123](name|values)$'))
  OR (item."targetType"::text = 'COLLECTION_MEMBERSHIP' AND (item."fieldPath" LIKE 'collection_membership.%' OR item."fieldPath" LIKE 'atomic.collection_membership.%' OR item."fieldPath" = 'product.collections'))
  OR (item."targetType"::text = 'METAFIELD' AND item."fieldPath" LIKE 'metafield.%')
)
ON CONFLICT ("shop", "snapshotSetId", "targetSnapshotItemId") DO NOTHING;

-- Canonicalization can collapse distinct legacy spellings onto the same field.
-- Keep the first immutable row and quarantine every duplicate before uniqueness.
WITH ranked AS (
  SELECT item."shop", item."snapshotSetId", item."id",
    row_number() OVER (
      PARTITION BY item."shop", item."snapshotSetId", item."targetKey", item."fieldPath"
      ORDER BY item."ordinal", item."id"
    ) AS duplicate_rank
  FROM "TargetSnapshotItem" item
)
INSERT INTO "TargetSnapshotItemQuarantine" (
  "shop", "snapshotSetId", "targetSnapshotItemId", "reason", "rowJson"
)
SELECT item."shop", item."snapshotSetId", item."id", 'DUPLICATE_TARGET_FIELD', to_jsonb(item)
FROM ranked
JOIN "TargetSnapshotItem" item
  ON item."shop" = ranked."shop"
 AND item."snapshotSetId" = ranked."snapshotSetId"
 AND item."id" = ranked."id"
WHERE ranked.duplicate_rank > 1
ON CONFLICT ("shop", "snapshotSetId", "targetSnapshotItemId") DO NOTHING;

UPDATE "TargetSnapshotSet" setrow
SET "status" = 'CORRUPTED',
    "freezeErrorCode" = 'TARGET_ITEM_QUARANTINED',
    "freezeErrorMessage" = 'One or more target rows had unprovable normalized identities'
WHERE EXISTS (
  SELECT 1 FROM "TargetSnapshotItemQuarantine" quarantine
  WHERE quarantine."shop" = setrow."shop"
    AND quarantine."snapshotSetId" = setrow."id"
);

DELETE FROM "TargetSnapshotItem" item
USING "TargetSnapshotItemQuarantine" quarantine
WHERE quarantine."shop" = item."shop"
  AND quarantine."snapshotSetId" = item."snapshotSetId"
  AND quarantine."targetSnapshotItemId" = item."id";

ALTER TABLE "TargetSnapshotItem"
  ADD CONSTRAINT "TargetSnapshotItem_identity_shape_check" CHECK (
    ("targetType"::text = 'PRODUCT' AND "productId" IS NOT NULL AND num_nonnulls("variantId", "inventoryItemId", "locationId", "collectionId", "productOptionPosition", "metafieldOwnerId", "metafieldOwnerType", "metafieldNamespace", "metafieldKey") = 0)
    OR ("targetType"::text = 'VARIANT' AND "productId" IS NOT NULL AND "variantId" IS NOT NULL AND num_nonnulls("inventoryItemId", "locationId", "collectionId", "productOptionPosition", "metafieldOwnerId", "metafieldOwnerType", "metafieldNamespace", "metafieldKey") = 0)
    OR ("targetType"::text = 'INVENTORY_ITEM' AND "productId" IS NOT NULL AND "variantId" IS NOT NULL AND "inventoryItemId" IS NOT NULL AND num_nonnulls("locationId", "collectionId", "productOptionPosition", "metafieldOwnerId", "metafieldOwnerType", "metafieldNamespace", "metafieldKey") = 0)
    OR ("targetType"::text = 'INVENTORY_LEVEL' AND "productId" IS NOT NULL AND "variantId" IS NOT NULL AND "inventoryItemId" IS NOT NULL AND "locationId" IS NOT NULL AND num_nonnulls("collectionId", "productOptionPosition", "metafieldOwnerId", "metafieldOwnerType", "metafieldNamespace", "metafieldKey") = 0)
    OR ("targetType"::text = 'PRODUCT_OPTION' AND "productId" IS NOT NULL AND "productOptionPosition" BETWEEN 1 AND 3 AND num_nonnulls("variantId", "inventoryItemId", "locationId", "collectionId", "metafieldOwnerId", "metafieldOwnerType", "metafieldNamespace", "metafieldKey") = 0)
    OR ("targetType"::text = 'COLLECTION_MEMBERSHIP' AND "productId" IS NOT NULL AND "collectionId" IS NOT NULL AND num_nonnulls("variantId", "inventoryItemId", "locationId", "productOptionPosition", "metafieldOwnerId", "metafieldOwnerType", "metafieldNamespace", "metafieldKey") = 0)
    OR ("targetType"::text = 'METAFIELD' AND "metafieldOwnerId" IS NOT NULL AND "metafieldOwnerType" IS NOT NULL AND "metafieldNamespace" IS NOT NULL AND "metafieldKey" IS NOT NULL AND num_nonnulls("productId", "variantId", "inventoryItemId", "locationId", "collectionId", "productOptionPosition") = 0)
  ) NOT VALID,
  ADD CONSTRAINT "TargetSnapshotItem_field_path_check"
    CHECK (length(btrim("fieldPath")) > 0) NOT VALID,
  ADD CONSTRAINT "TargetSnapshotItem_field_family_check" CHECK (
    ("targetType"::text = 'PRODUCT' AND ("fieldPath" LIKE 'product.%' OR "fieldPath" LIKE 'atomic.product.%'))
    OR ("targetType"::text = 'VARIANT' AND ("fieldPath" LIKE 'variant.%' OR "fieldPath" LIKE 'atomic.variant.%'))
    OR ("targetType"::text = 'INVENTORY_ITEM' AND ("fieldPath" LIKE 'inventory_item.%' OR "fieldPath" LIKE 'atomic.inventory_item.%'))
    OR ("targetType"::text = 'INVENTORY_LEVEL' AND ("fieldPath" LIKE 'inventory_level.%' OR "fieldPath" LIKE 'atomic.inventory_level.%'))
    OR ("targetType"::text = 'PRODUCT_OPTION' AND ("fieldPath" LIKE 'product_option.%' OR "fieldPath" LIKE 'atomic.product_option.%' OR "fieldPath" ~ '^product\.option[123](name|values)$'))
    OR ("targetType"::text = 'COLLECTION_MEMBERSHIP' AND ("fieldPath" LIKE 'collection_membership.%' OR "fieldPath" LIKE 'atomic.collection_membership.%' OR "fieldPath" = 'product.collections'))
    OR ("targetType"::text = 'METAFIELD' AND "fieldPath" LIKE 'metafield.%')
  ) NOT VALID;

ALTER TABLE "TargetSnapshotItem" VALIDATE CONSTRAINT "TargetSnapshotItem_identity_shape_check";
ALTER TABLE "TargetSnapshotItem" VALIDATE CONSTRAINT "TargetSnapshotItem_field_path_check";
ALTER TABLE "TargetSnapshotItem" VALIDATE CONSTRAINT "TargetSnapshotItem_field_family_check";
ALTER TABLE "TargetSnapshotItem" ALTER COLUMN "fieldPath" SET NOT NULL;

CREATE UNIQUE INDEX "TargetSnapshotItem_shop_snapshotSetId_targetKey_fieldPath_key"
  ON "TargetSnapshotItem" ("shop", "snapshotSetId", "targetKey", "fieldPath");

UPDATE "TargetSnapshotItem" item
SET "targetFingerprint" = md5(item."targetKey" || ':' || item."fieldPath"),
    "rowChecksum" = md5(
      item."shop" || ':' || item."snapshotSetId" || ':' || item."targetKey" || ':' ||
      item."fieldPath" || ':' || item."beforeValueHash" || ':' || item."plannedValueHash"
    );

UPDATE "TargetSnapshotSet" setrow
SET "targetCount" = counts."targetCount",
    "productCount" = counts."productCount",
    "variantCount" = counts."variantCount",
    "inventoryItemCount" = counts."inventoryItemCount",
    "metafieldCount" = counts."metafieldCount",
    "productOptionCount" = counts."productOptionCount",
    "collectionMembershipCount" = counts."collectionMembershipCount",
    "inventoryLevelCount" = counts."inventoryLevelCount",
    "pendingCount" = counts."pendingCount",
    "submittedCount" = counts."submittedCount",
    "succeededCount" = counts."succeededCount",
    "failedCount" = counts."failedCount",
    "skippedCount" = counts."skippedCount",
    "checksum" = counts."targetSetHash"
FROM (
  SELECT item."shop", item."snapshotSetId",
    COUNT(*)::integer AS "targetCount",
    COUNT(*) FILTER (WHERE item."targetType"::text = 'PRODUCT')::integer AS "productCount",
    COUNT(*) FILTER (WHERE item."targetType"::text = 'VARIANT')::integer AS "variantCount",
    COUNT(*) FILTER (WHERE item."targetType"::text = 'INVENTORY_ITEM')::integer AS "inventoryItemCount",
    COUNT(*) FILTER (WHERE item."targetType"::text = 'METAFIELD')::integer AS "metafieldCount",
    COUNT(*) FILTER (WHERE item."targetType"::text = 'PRODUCT_OPTION')::integer AS "productOptionCount",
    COUNT(*) FILTER (WHERE item."targetType"::text = 'COLLECTION_MEMBERSHIP')::integer AS "collectionMembershipCount",
    COUNT(*) FILTER (WHERE item."targetType"::text = 'INVENTORY_LEVEL')::integer AS "inventoryLevelCount",
    COUNT(*) FILTER (WHERE item."executionStatus"::text = 'PENDING')::integer AS "pendingCount",
    COUNT(*) FILTER (WHERE item."executionStatus"::text = 'SUBMITTED')::integer AS "submittedCount",
    COUNT(*) FILTER (WHERE item."executionStatus"::text = 'SUCCEEDED')::integer AS "succeededCount",
    COUNT(*) FILTER (WHERE item."executionStatus"::text = 'FAILED')::integer AS "failedCount",
    COUNT(*) FILTER (WHERE item."executionStatus"::text = 'SKIPPED')::integer AS "skippedCount",
    md5(string_agg(item."rowChecksum", E'\n' ORDER BY item."targetKey", item."fieldPath")) AS "targetSetHash"
  FROM "TargetSnapshotItem" item
  GROUP BY item."shop", item."snapshotSetId"
) counts
WHERE counts."shop" = setrow."shop"
  AND counts."snapshotSetId" = setrow."id";
