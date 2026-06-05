import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (p) => fs.readFileSync(path.resolve(p), "utf8");

test("bulk edit preview utilities use valid imports and no row spreading", () => {
  const source = read("web/services/bulkEdit/bulkEditTargetUtils.js");
  assert.equal(source.includes("const db = defaultDb;"), false);
  assert.equal(source.includes("...rawProduct"), false);
  assert.equal(source.includes("...variant"), false);
  assert.equal(source.includes("variants: true"), false);
  assert.equal(source.includes("mirrorBatchId = null"), false);
  assert.ok(source.includes("select: PREVIEW_VARIANT_SELECT"));
});

test("preview normalizers return explicit public fields only", () => {
  const source = read("web/services/bulkEdit/bulkEditTargetUtils.js");
  assert.ok(source.includes("id: rawProduct.id == null ? null : String(rawProduct.id)"));
  assert.ok(source.includes("descriptionHtml: rawProduct.descriptionHtml ?? null"));
  assert.ok(source.includes("descriptionText: rawProduct.descriptionText ?? null"));
  assert.ok(source.includes("id: variant.id == null ? null : String(variant.id)"));
  assert.equal(source.includes("shop: rawProduct"), false);
  assert.equal(source.includes("shop: variant"), false);
  assert.equal(source.includes("mirrorBatchId: rawProduct"), false);
  assert.equal(source.includes("mirrorBatchId: variant"), false);
  assert.equal(source.includes("description:\n      rawProduct.descriptionHtml"), false);
  assert.equal(source.includes("description: rawProduct.descriptionHtml"), false);
});

test("preview normalizers validate object shape and dual sources", () => {
  const source = read("web/services/bulkEdit/bulkEditTargetUtils.js");
  assert.ok(source.includes("assertPlainObject(rawProduct, \"PREVIEW_PRODUCT\")"));
  assert.ok(source.includes("assertPlainObject(variant, \"PREVIEW_VARIANT\")"));
  assert.ok(source.includes("label: \"PRODUCT_OPTIONS\""));
  assert.ok(source.includes("label: \"PRODUCT_COLLECTIONS\""));
  assert.ok(source.includes("label: \"VARIANT_SELECTED_OPTIONS\""));
  assert.ok(source.includes("PREVIEW_${label}_SOURCE_MISMATCH"));
});

test("variant include and fallback hydration are scoped and selected", () => {
  const source = read("web/services/bulkEdit/bulkEditTargetUtils.js");
  assert.ok(source.includes("variants: {\n      select: PREVIEW_VARIANT_SELECT"));
  assert.ok(source.includes("PREVIEW_VARIANT_HYDRATION_REQUIRES_SHOP_AND_MIRROR_BATCH"));
  assert.ok(source.includes("mirrorBatchId: resolvedMirrorBatchId"));
  assert.ok(source.includes("select: PREVIEW_VARIANT_SELECT"));
  assert.ok(source.includes("String(variant.productId).trim()"));
});

test("legacy preview helper delegates to hardened bulk edit utility", () => {
  const source = read("web/services/productService/helpers/bulkEditPreviewHelpers.js");
  assert.ok(source.includes("../../bulkEdit/bulkEditTargetUtils.js"));
  assert.equal(source.includes("variants: true"), false);
  assert.equal(source.includes("...rawProduct"), false);
});
