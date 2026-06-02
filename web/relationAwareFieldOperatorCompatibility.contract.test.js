import test from "node:test";
import assert from "node:assert/strict";

import { compileRelationAwareAstWhereSql } from "./services/targeting/compile/relationAwareSqlResolver.js";

function compileSinglePredicate(field, operator, value, meta = {}) {
  return compileRelationAwareAstWhereSql(
    {
      root: {
        nodeType: "group",
        logic: "AND",
        children: [{ nodeType: "predicate", field, operator, value, meta }],
      },
    },
    {
      targetType: "PRODUCT",
      shop: "shop.myshopify.com",
      mirrorBatchId: "batch_1",
    },
  );
}

function expectErrorCode(fn, expectedCode) {
  assert.throws(fn, (error) => error?.code === expectedCode);
}

test("collections supports only IN/NOT_IN/EXISTS/NOT_EXISTS", () => {
  assert.doesNotThrow(() => compileSinglePredicate("collections", "IN", ["gid://shopify/Collection/1"]));
  assert.doesNotThrow(() => compileSinglePredicate("collections", "NOT_IN", ["gid://shopify/Collection/1"]));
  assert.doesNotThrow(() => compileSinglePredicate("collections", "EXISTS", null));
  assert.doesNotThrow(() => compileSinglePredicate("collections", "NOT_EXISTS", null));

  expectErrorCode(
    () => compileSinglePredicate("collections", "CONTAINS", "foo"),
    "UNSUPPORTED_RELATION_OPERATOR",
  );
});

test("collections IN/NOT_IN require non-empty string arrays", () => {
  expectErrorCode(
    () => compileSinglePredicate("collections", "IN", "gid://shopify/Collection/1"),
    "RELATION_VALUE_INVALID_TYPE",
  );
  expectErrorCode(
    () => compileSinglePredicate("collections", "NOT_IN", []),
    "RELATION_VALUE_INVALID_TYPE",
  );
});

test("metafield predicates require namespace/key metadata", () => {
  expectErrorCode(
    () => compileSinglePredicate("productMetafield", "EQ", "sale"),
    "METAFIELD_NAMESPACE_KEY_REQUIRED",
  );
  expectErrorCode(
    () => compileSinglePredicate("variantMetafield", "CONTAINS", "xl", { namespace: "spec" }),
    "METAFIELD_NAMESPACE_KEY_REQUIRED",
  );
});

test("metafield scalar operators require scalar string-like values", () => {
  const meta = { namespace: "custom", key: "badge" };
  assert.doesNotThrow(() => compileSinglePredicate("productMetafield", "EQ", "sale", meta));
  assert.doesNotThrow(() => compileSinglePredicate("productMetafield", "CONTAINS", "vip", meta));
  expectErrorCode(
    () => compileSinglePredicate("productMetafield", "EQ", ["sale"], meta),
    "RELATION_VALUE_INVALID_TYPE",
  );
  expectErrorCode(
    () => compileSinglePredicate("productMetafield", "NOT_CONTAINS", { x: 1 }, meta),
    "RELATION_VALUE_INVALID_TYPE",
  );
});

test("metafield supports explicit operator matrix and rejects unsupported operators", () => {
  const meta = { namespace: "custom", key: "badge" };
  assert.doesNotThrow(() => compileSinglePredicate("variantMetafield", "EXISTS", null, meta));
  assert.doesNotThrow(() => compileSinglePredicate("variantMetafield", "NOT_EXISTS", null, meta));
  assert.doesNotThrow(() => compileSinglePredicate("variantMetafield", "IS_EMPTY", null, meta));
  assert.doesNotThrow(() => compileSinglePredicate("variantMetafield", "IS_NOT_EMPTY", null, meta));
  expectErrorCode(
    () => compileSinglePredicate("variantMetafield", "IN", ["x"], meta),
    "UNSUPPORTED_RELATION_OPERATOR",
  );
});
