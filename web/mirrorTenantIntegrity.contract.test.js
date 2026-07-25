import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(path, "utf8");

test("mirror identities and relations are tenant and batch scoped", () => {
  const schema = read("web/prisma/schema.prisma");

  assert.match(schema, /model MirrorBatch[\s\S]*?@@id\(\[shop, id\]\)/);
  assert.match(schema, /model Collection[\s\S]*?@@id\(\[shop, shopifyId, mirrorBatchId\]\)/);
  assert.match(schema, /model ProductTombstone[\s\S]*?@@id\(\[shop, productId\]\)/);
  assert.match(
    schema,
    /product\s+Product\s+@relation\(fields: \[shop, productId, mirrorBatchId\], references: \[shop, id, mirrorBatchId\], onDelete: Cascade\)/,
  );
  assert.match(
    schema,
    /snapshotSet\s+TargetSnapshotSet\s+@relation\(fields: \[shop, snapshotSetId, mirrorBatchId\], references: \[shop, id, mirrorBatchId\], onDelete: Cascade\)/,
  );
});

test("migration validates legacy rows before installing cascade foreign keys", () => {
  const migration = read(
    "web/prisma/migrations/20260722103000_tenant_scope_mirror_foreign_keys/migration.sql",
  );

  assert.match(migration, /Product contains an orphan or cross-shop mirrorBatchId/);
  assert.match(migration, /PRIMARY KEY USING INDEX "MirrorBatch_shop_id_key"/);
  assert.match(migration, /Product_shop_mirrorBatchId_fkey/);
  assert.match(migration, /InventoryItemMirror_shop_variantId_mirrorBatchId_fkey/);
  assert.match(migration, /ProductCollection_shop_collectionId_mirrorBatchId_fkey/);
  assert.match(migration, /ON DELETE CASCADE ON UPDATE CASCADE NOT VALID/);
  assert.match(migration, /VALIDATE CONSTRAINT/);
});

test("product delete no longer generates a tombstone surrogate id", () => {
  const worker = read("web/Jobs/Workers/productDeleteWorker.js");
  assert.doesNotMatch(worker, /randomUUID/);
  assert.match(worker, /shop_productId: \{ shop, productId \}/);
});
