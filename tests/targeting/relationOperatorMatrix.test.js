const test = require("node:test");
const assert = require("node:assert/strict");

async function compilePredicate(predicate) {
  const mod = await import("../../web/services/targeting/compile/relationAwareSqlResolver.js");
  return mod.compileRelationAwareAstWhereSql(
    {
      root: {
        nodeType: "group",
        logic: "AND",
        children: [predicate],
      },
    },
    {
      targetType: "PRODUCT",
      shop: "shop.myshopify.com",
      mirrorBatchId: "batch_1",
    },
  );
}

async function expectCompileRejectCode(predicate, code) {
  let thrown = null;
  try {
    await compilePredicate(predicate);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, `expected error ${code}`);
  assert.equal(thrown.code, code);
}

test("collections operator matrix", async () => {
  await compilePredicate({
    nodeType: "predicate",
    field: "collections",
    operator: "IN",
    value: ["C1"],
  });
  await compilePredicate({
    nodeType: "predicate",
    field: "collections",
    operator: "NOT_IN",
    value: ["C1"],
  });
  await compilePredicate({
    nodeType: "predicate",
    field: "collections",
    operator: "EXISTS",
    value: null,
  });
  await compilePredicate({
    nodeType: "predicate",
    field: "collections",
    operator: "NOT_EXISTS",
    value: null,
  });

  await expectCompileRejectCode({
    nodeType: "predicate",
    field: "collections",
    operator: "CONTAINS",
    value: "C1",
  }, "RELATION_OPERATOR_UNSUPPORTED");
});

test("collections value coercion strictness", async () => {
  await expectCompileRejectCode({
    nodeType: "predicate",
    field: "collections",
    operator: "IN",
    value: "C1",
  }, "RELATION_OPERATOR_REQUIRES_ARRAY");

  await expectCompileRejectCode({
    nodeType: "predicate",
    field: "collections",
    operator: "IN",
    value: [],
  }, "RELATION_VALUE_EMPTY");

  await expectCompileRejectCode({
    nodeType: "predicate",
    field: "collections",
    operator: "IN",
    value: ["", " "],
  }, "RELATION_VALUE_EMPTY");
});

test("metafield operator matrix and strict metadata", async () => {
  await compilePredicate({
    nodeType: "predicate",
    field: "productMetafield",
    operator: "EQ",
    value: "sale",
    meta: { namespace: "custom", key: "badge" },
  });
  await compilePredicate({
    nodeType: "predicate",
    field: "variantMetafield",
    operator: "EXISTS",
    value: null,
    meta: { namespace: "spec", key: "size" },
  });

  await expectCompileRejectCode({
    nodeType: "predicate",
    field: "productMetafield",
    operator: "IN",
    value: ["sale"],
    meta: { namespace: "custom", key: "badge" },
  }, "RELATION_OPERATOR_UNSUPPORTED");

  await expectCompileRejectCode({
    nodeType: "predicate",
    field: "productMetafield",
    operator: "EQ",
    value: "sale",
    meta: { namespace: "", key: "badge" },
  }, "RELATION_VALUE_TYPE_INVALID");
});

test("metafield strict scalar value rules", async () => {
  await expectCompileRejectCode({
    nodeType: "predicate",
    field: "productMetafield",
    operator: "EQ",
    value: ["sale"],
    meta: { namespace: "custom", key: "badge" },
  }, "RELATION_VALUE_TYPE_INVALID");

  await expectCompileRejectCode({
    nodeType: "predicate",
    field: "productMetafield",
    operator: "EQ",
    value: "",
    meta: { namespace: "custom", key: "badge" },
  }, "RELATION_VALUE_EMPTY");
});

