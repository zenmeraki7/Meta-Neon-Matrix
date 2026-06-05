import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.resolve("web/graphql/product.js"), "utf8");
const syncSource = fs.readFileSync(
  path.resolve("web/services/productService/productSyncService.js"),
  "utf8",
);

test("product sync and export queries share core product and variant selections", () => {
  assert.ok(source.includes("const PRODUCT_CORE_FIELDS"));
  assert.ok(source.includes("const VARIANT_FIELDS"));
  assert.ok(source.includes("${PRODUCT_CORE_FIELDS}"));
  assert.ok(source.includes("${VARIANT_FIELDS}"));
  assert.ok(source.includes("export const PRODUCT_NESTED_CONNECTION_PAGE_SIZE = 250"));
  assert.equal(source.includes("variants(first: 100)"), false);
});

test("product queries expose nested pagination metadata instead of silent fixed caps", () => {
  assert.ok(source.includes("variants(first: ${PRODUCT_NESTED_CONNECTION_PAGE_SIZE})"));
  assert.ok(source.includes("metafields(first: ${PRODUCT_NESTED_CONNECTION_PAGE_SIZE})"));
  assert.ok(source.includes("collections(first: ${PRODUCT_NESTED_CONNECTION_PAGE_SIZE})"));
  assert.ok(source.includes("pageInfo"));
  assert.ok(source.includes("hasNextPage"));
  assert.ok(source.includes("endCursor"));
  assert.ok(syncSource.includes("assertNestedConnectionNotTruncated"));
  assert.ok(syncSource.includes("PRODUCT_SYNC_NESTED_CONNECTION_TRUNCATED"));
});

test("product export query includes inventory item identifiers for round trips", () => {
  const inventoryItemIndex = source.indexOf("inventoryItem {");
  const inventoryItemIdIndex = source.indexOf("id", inventoryItemIndex);
  assert.ok(inventoryItemIndex > -1);
  assert.ok(inventoryItemIdIndex > inventoryItemIndex);
});

test("product queries request typenames for nested objects used by ingestion", () => {
  for (const selection of [
    "inventoryItem {\n    __typename",
    "selectedOptions {\n    __typename",
    "unitCost {\n      __typename",
    "measurement {\n      __typename",
    "weight {\n        __typename",
    "seo {\n    __typename",
    "preview {\n        __typename",
    "image {\n          __typename",
  ]) {
    assert.ok(source.includes(selection), `missing ${selection}`);
  }
});
