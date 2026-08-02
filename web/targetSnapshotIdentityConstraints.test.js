import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { normalizeTargetSnapshotRow } from "./helpers/targetSnapshotFieldRegistry.js";
import {
  decodeSnapshotItemCursor,
  encodeSnapshotItemCursor,
} from "./repositories/targetSnapshotSetRepository.js";

test("target keys and field paths are constructed server-side", () => {
  const row = normalizeTargetSnapshotRow({
    targetResourceType: "PRODUCT",
    targetKey: "ATTACKER:CONTROLLED",
    productId: "gid://shopify/Product/1",
    plannedMutation: {
      productFieldChanges: [{ field: "Meta Title", oldValue: "before", newValue: "after" }],
    },
  });
  assert.equal(row.targetKey, "PRODUCT:gid://shopify/Product/1");
  assert.equal(row.fieldPath, "product.metaTitle");
  assert.match(row.beforeValueHash, /^[a-f0-9]{64}$/);
  assert.match(row.plannedValueHash, /^[a-f0-9]{64}$/);
});

test("target families require their normalized identities", () => {
  assert.throws(
    () => normalizeTargetSnapshotRow({
      targetResourceType: "VARIANT",
      productId: "p1",
      plannedMutation: { variantFieldChanges: [{ variantId: "v1", changes: [{ field: "price", newValue: "10" }] }] },
    }),
    { code: "TARGET_IDENTITY_COMBINATION_INVALID" }
  );

  const inventory = normalizeTargetSnapshotRow({
    targetResourceType: "VARIANT",
    productId: "p1",
    variantId: "v1",
    inventoryItemId: "i1",
    locationId: "l1",
    plannedMutation: { variantFieldChanges: [{ variantId: "v1", changes: [{ field: "inventory", oldValue: 2, newValue: 3 }] }] },
  });
  assert.equal(inventory.targetResourceType, "INVENTORY_LEVEL");
  assert.equal(inventory.targetKey, "INVENTORY_LEVEL:i1:l1");
});

test("metafield and product-option identities are normalized", () => {
  const metafield = normalizeTargetSnapshotRow({
    targetResourceType: "METAFIELD",
    productId: "p1",
    plannedMutation: {
      metafield: { ownerId: "p1", ownerType: "PRODUCT", namespace: "custom", key: "rating", oldValue: "1", value: "2" },
    },
  });
  assert.equal(metafield.targetKey, "METAFIELD:PRODUCT:p1:custom:rating");
  assert.equal(metafield.fieldPath, "metafield.custom.rating");

  const option = normalizeTargetSnapshotRow({
    targetResourceType: "PRODUCT",
    productId: "p1",
    plannedMutation: { productFieldChanges: [{ field: "option2Name", oldValue: "Size", newValue: "Fit" }] },
  });
  assert.equal(option.targetResourceType, "PRODUCT_OPTION");
  assert.equal(option.productOptionPosition, 2);
  assert.equal(option.targetKey, "PRODUCT_OPTION:p1:2");
});

test("unrelated multi-field mutations require an explicit atomic group", () => {
  const input = {
    targetResourceType: "PRODUCT",
    productId: "p1",
    plannedMutation: {
      productFieldChanges: [
        { field: "title", oldValue: "a", newValue: "b" },
        { field: "vendor", oldValue: "x", newValue: "y" },
      ],
    },
  };
  assert.throws(() => normalizeTargetSnapshotRow(input), {
    code: "TARGET_MULTI_FIELD_ROW_REQUIRES_ATOMIC_GROUP",
  });
  const atomic = normalizeTargetSnapshotRow({ ...input, atomicMutationGroup: true });
  assert.match(atomic.fieldPath, /^atomic\.product\.[a-f0-9]{24}$/);
});

test("migration quarantines invalid rows before validating database checks", () => {
  const migration = fs.readFileSync(
    "web/prisma/migrations/20260801090000_normalize_target_snapshot_item_identity/migration.sql",
    "utf8"
  );
  assert.match(migration, /TargetSnapshotItemQuarantine/);
  assert.match(migration, /NOT VALID/);
  assert.match(migration, /VALIDATE CONSTRAINT "TargetSnapshotItem_identity_shape_check"/);
  assert.match(migration, /shop_snapshotSetId_targetKey_fieldPath_key/);
  assert.match(migration, /jsonb_populate_record/);
});

test("snapshot pagination preserves multiple fields for the same target", () => {
  const cursor = encodeSnapshotItemCursor({
    targetKey: "PRODUCT:p1",
    fieldPath: "product.title",
  });
  assert.deepEqual(decodeSnapshotItemCursor(cursor), {
    targetKey: "PRODUCT:p1",
    fieldPath: "product.title",
  });
});
