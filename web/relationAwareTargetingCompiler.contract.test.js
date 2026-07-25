import test from "node:test";
import assert from "node:assert/strict";

import { compileRelationAwareAstWhereSql } from "./services/targeting/compile/relationAwareSqlResolver.js";

test("relation-aware compiler supports nested AND/OR/NOT with collections and metafields", () => {
  const ast = {
    root: {
      nodeType: "group",
      logic: "AND",
      children: [
        {
          nodeType: "predicate",
          field: "collections",
          operator: "IN",
          value: ["gid://shopify/Collection/1"],
        },
        {
          nodeType: "group",
          logic: "OR",
          not: true,
          children: [
            {
              nodeType: "predicate",
              field: "productMetafield",
              operator: "CONTAINS",
              value: "sale",
              meta: { namespace: "custom", key: "badge" },
            },
            {
              nodeType: "predicate",
              field: "variantMetafield",
              operator: "EXISTS",
              value: "x",
              meta: { namespace: "spec", key: "size" },
            },
          ],
        },
      ],
    },
  };

  const compiled = compileRelationAwareAstWhereSql(ast, {
    targetResourceType: "PRODUCT",
    shop: "s.myshopify.com",
    mirrorBatchId: "batch_1",
  });

  assert.ok(compiled.whereSql.includes("\"ProductCollection\""));
  assert.ok(compiled.whereSql.includes("\"MetafieldMirror\""));
  assert.ok(compiled.whereSql.includes("NOT ("));
  assert.equal(compiled.params[0], "s.myshopify.com");
  assert.equal(compiled.params[1], "batch_1");
});

