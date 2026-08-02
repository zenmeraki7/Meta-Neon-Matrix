import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  buildImmutableUndoItems,
  hashUndoValue,
  unwrapUndoValue,
} from "./services/undo/undoValueIntegrity.js";

test("undo hashes use canonical field semantics", () => {
  assert.equal(hashUndoValue("product.tags", ["b", "a"]), hashUndoValue("product.tags", ["a", "b"]));
  assert.equal(hashUndoValue("variant:1.price", "10.00"), hashUndoValue("variant:1.price", 10));
  assert.notEqual(hashUndoValue("product.title", "old"), hashUndoValue("product.title", "new"));
});

test("immutable undo items retain explicit null restore values and written hashes", () => {
  const [item] = buildImmutableUndoItems([
    {
      targetIdentity: "PRODUCT:1",
      productId: "gid://shopify/Product/1",
      productFieldChanges: [
        { field: "vendor", oldValue: "legacy", revertValue: null, newValue: "new" },
      ],
    },
  ]);
  assert.equal(unwrapUndoValue(item.beforeValue), null);
  assert.equal(item.beforeValueHash, hashUndoValue("product.vendor", null));
  assert.equal(item.writtenValueHash, hashUndoValue("product.vendor", "new"));
  assert.equal(item.outcome, "APPROVED");
});

test("schema and migration enforce repeatable, tenant-scoped immutable undo", () => {
  const schema = fs.readFileSync("web/prisma/schema.prisma", "utf8");
  const migration = fs.readFileSync(
    "web/prisma/migrations/20260731210000_add_immutable_undo_items/migration.sql",
    "utf8"
  );
  assert.match(schema, /model UndoItem\s*\{/);
  assert.match(schema, /@@unique\(\[shop, idempotencyKeyHash\]\)/);
  assert.doesNotMatch(schema.match(/model UndoOperation\s*\{[\s\S]*?\n\}/)?.[0] || "", /@@unique\(\[shop, sourceEditHistoryId\]\)/);
  assert.match(migration, /LEGACY_UNTRUSTED/);
  assert.match(migration, /reject_undo_item_authority_update/);
  assert.match(migration, /FOREIGN KEY \("shop", "undoOperationId"\)/);
});

test("workers compare live hashes and never trust browser restore payloads", () => {
  const service = fs.readFileSync(
    "web/services/productService/productBulkUndoService.js",
    "utf8"
  );
  const worker = fs.readFileSync("web/Jobs/Workers/bulkUndoWorker.js", "utf8");
  assert.match(service, /expectedAfterHash === currentValueHash/);
  assert.match(service, /hydrateReplayRecordsFromUndoItems/);
  assert.match(worker, /findTrustedUndoItems/);
  assert.match(worker, /persistUndoItemPreflight/);
});
