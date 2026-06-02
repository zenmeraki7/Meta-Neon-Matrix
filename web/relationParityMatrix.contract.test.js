import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { compileRelationAwareAstWhereSql } from "./services/targeting/compile/relationAwareSqlResolver.js";

function read(filePath) {
  return fs.readFileSync(path.resolve(filePath), "utf8");
}

function buildContexts() {
  return [
    { targetType: "PRODUCT", shop: "s.myshopify.com", mirrorBatchId: "batch_1" },
    { targetType: "VARIANT", shop: "s.myshopify.com", mirrorBatchId: "batch_1" },
  ];
}

function matrixAsts() {
  return [
    {
      name: "and_or_not_mixed_relations_product_variant",
      ast: {
        root: {
          nodeType: "group",
          logic: "AND",
          children: [
            { nodeType: "predicate", field: "vendor", operator: "CONTAINS", value: "acme" },
            {
              nodeType: "group",
              logic: "OR",
              not: true,
              children: [
                {
                  nodeType: "predicate",
                  field: "collections",
                  operator: "IN",
                  value: ["gid://shopify/Collection/1", "gid://shopify/Collection/2"],
                },
                {
                  nodeType: "predicate",
                  field: "productMetafield",
                  operator: "CONTAINS",
                  value: "sale",
                  meta: { namespace: "custom", key: "badge" },
                },
              ],
            },
          ],
        },
      },
    },
    {
      name: "variant_metafield_plus_scalar_variant",
      ast: {
        root: {
          nodeType: "group",
          logic: "AND",
          children: [
            { nodeType: "predicate", field: "price", operator: "GTE", value: 10 },
            {
              nodeType: "predicate",
              field: "variantMetafield",
              operator: "EXISTS",
              value: "x",
              meta: { namespace: "spec", key: "size" },
            },
          ],
        },
      },
    },
    {
      name: "nested_or_between_product_and_variant_constraints",
      ast: {
        root: {
          nodeType: "group",
          logic: "OR",
          children: [
            { nodeType: "predicate", field: "status", operator: "EQ", value: "ACTIVE" },
            {
              nodeType: "group",
              logic: "AND",
              children: [
                { nodeType: "predicate", field: "inventoryQuantity", operator: "BETWEEN", value: [1, 100] },
                { nodeType: "predicate", field: "collections", operator: "NOT_IN", value: ["gid://shopify/Collection/9"] },
              ],
            },
          ],
        },
      },
    },
  ];
}

test("targeting engine removes legacy relation fallback branch", () => {
  const src = read("web/services/targeting/TargetingEngineService.js");
  assert.equal(src.includes("usesRelationFallback"), false);
  assert.equal(src.includes("buildLegacyFilterParamsFromAst"), false);
});

test("relation parity matrix compiles deterministically across mixed AST predicates", () => {
  for (const entry of matrixAsts()) {
    for (const context of buildContexts()) {
      const first = compileRelationAwareAstWhereSql(entry.ast, context);
      const second = compileRelationAwareAstWhereSql(entry.ast, context);

      assert.equal(first.whereSql, second.whereSql, `${entry.name}:${context.targetType} whereSql drift`);
      assert.deepEqual(first.params, second.params, `${entry.name}:${context.targetType} params drift`);
      assert.equal(first.params[0], context.shop);
      assert.equal(first.params[1], context.mirrorBatchId);
      assert.ok(first.whereSql.includes("ProductCollection") || first.whereSql.includes("MetafieldMirror") || first.whereSql.includes('"price"'));
    }
  }
});

