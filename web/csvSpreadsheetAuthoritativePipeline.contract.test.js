import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildProductSetMutation, diffProductFields, diffVariants } from "./utils/importEditUtils.js";

const read = (path) => fs.readFileSync(path, "utf8");

test("CSV diffs preserve trusted old values and skip normalized no-ops", () => {
  const productChanges = diffProductFields(
    { title: "Old title", vendor: "Same", status: "DRAFT", tags: ["a", "b"] },
    { title: "New title", vendor: "Same", status: "ACTIVE", tags: ["a", "b"] },
  );

  assert.deepEqual(productChanges, [
    { field: "title", oldValue: "Old title", newValue: "New title", revertValue: "Old title" },
    { field: "status", oldValue: "DRAFT", newValue: "ACTIVE", revertValue: "DRAFT" },
  ]);

  const variantChanges = diffVariants(
    [{ id: "gid://shopify/ProductVariant/1", price: "10.00", sku: "OLD" }],
    [{ id: "gid://shopify/ProductVariant/1", price: "10.00", sku: "NEW" }],
  );
  assert.equal(variantChanges[0].changes.length, 1);
  assert.equal(variantChanges[0].changes[0].oldValue, "OLD");
  assert.equal(variantChanges[0].changes[0].newValue, "NEW");
});

test("product-only CSV edits do not send product options with an empty variants input", () => {
  const mutation = buildProductSetMutation({
    productSet: {
      id: "gid://shopify/Product/1",
      title: "Updated",
      vendor: "Updated vendor",
      variants: [],
    },
    existingProduct: {
      options: [{ name: "Color", values: ["Green"] }],
      variants: [{ id: "gid://shopify/ProductVariant/1" }],
    },
  });

  assert.equal(mutation.productSet.title, "Updated");
  assert.equal(Object.hasOwn(mutation.productSet, "productOptions"), false);
  assert.equal(Object.hasOwn(mutation.productSet, "variants"), false);
});

test("CSV preparation freezes before and after values and disables unsupported create undo", () => {
  const source = read("web/Jobs/Workers/bulkImportEditWorker.js");
  assert.match(source, /afterValues:\s*\{\s*productFieldChanges,\s*variantFieldChanges/);
  assert.match(source, /plannedMutation:\s*\{\s*productFieldChanges,\s*variantFieldChanges/);
  assert.match(source, /allowed:\s*!containsProductCreates/);
});

test("CSV ingestion preserves Shopify's real created product id", () => {
  const source = read("web/services/bulkEdit/BulkEditResultIngestionService.js");
  assert.match(source, /isCsvImport\s*&&\s*item\.productId/);
  assert.match(source, /productId:\s*item\.productId/);
  assert.match(source, /row\.status === "SUCCESS" && undoAllowed/);
  assert.match(source, /\? "PENDING"\s*:\s*"NOT_REQUIRED"/);
});

test("undo submission backfills eligible legacy CSV snapshots", () => {
  const source = read("web/services/productService/productBulkUndoService.js");
  assert.match(source, /undoableTargetKeys/);
  assert.match(source, /undoStatus:\s*"NOT_REQUIRED"/);
  assert.match(source, /data:\s*\{ undoStatus:\s*"PENDING" \}/);
});

test("CSV verification ignores the submission batch mismatch and reconciles Shopify truth", () => {
  const verify = read("web/services/bulkEdit/BulkEditVerificationService.js");
  const ingest = read("web/services/bulkEdit/BulkEditResultIngestionService.js");
  assert.match(verify, /history\.isSpreadsheetEdit !== true && batchId/);
  assert.match(verify, /reconcileVerifiedShopifyStateIntoActiveMirror/);
  assert.doesNotMatch(ingest, /applyMirrorFromSuccessfulChangeRecords\(/);
});

test("verified mirror reconciliation is tenant and active-generation scoped", () => {
  const source = read("web/services/bulkEdit/BulkEditMirrorApplyService.js");
  assert.match(source, /shop_id_mirrorBatchId/);
  assert.match(source, /currentStore\?\.currentProductMirrorBatchId/);
  assert.match(source, /clearKeyCaches\(`\$\{shop\}:ProductFetch:`\)/);
});
