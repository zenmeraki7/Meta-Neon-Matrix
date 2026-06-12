import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("frontend does not call fake /api/sessions endpoints", () => {
  const productsPage = read("./frontend/Domain/products/list/pages/Products.jsx");
  assert.equal(productsPage.includes("/api/sessions"), false);
});

test("edit preview hook sends canonical operation/value contract", () => {
  const hook = read("./frontend/Domain/products/edit/hooks/useEditPreviewQuery.js");

  assert.match(hook, /operation: payload\.operation/);
  assert.match(hook, /value: payload\.editValue/);
  assert.doesNotMatch(hook, /editType: payload\.editType/);
  assert.doesNotMatch(hook, /editValue: payload\.editValue/);
});

test("price edit preview sends product filters with matching variant granularity", () => {
  const hook = read("./frontend/Domain/products/edit/hooks/useEditPreviewQuery.js");
  const builder = read("./frontend/Domain/products/list/utils/filterAst.js");

  assert.match(hook, /PRODUCT_WITH_MATCHING_VARIANTS/);
  assert.match(hook, /VARIANT_LEVEL_PREVIEW_FIELDS/);
  assert.match(builder, /PRODUCT_WITH_MATCHING_VARIANTS/);
});
