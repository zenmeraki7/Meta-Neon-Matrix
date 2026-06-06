import test from "node:test";
import assert from "node:assert/strict";

import { getProductPrismaWhere } from "./services/productService/productFilterCompiler.js";
import {
  buildNormalizedFilterPlan,
  mergeResolvedIdSets,
} from "./services/productService/normalizedFilterPlan.js";

test("buildNormalizedFilterPlan captures collection and metafield filters", () => {
  const plan = buildNormalizedFilterPlan([
    {
      field: "collections",
      operator: "is",
      value: {
        id: "gid://shopify/Collection/100",
        title: "Summer",
      },
    },
    {
      field: "metafield",
      operator: "equals",
      namespace: "custom",
      key: "material",
      value: "cotton",
    },
    {
      field: "variantMetafield",
      operator: "contains",
      namespace: "spec",
      key: "country",
      value: "india",
    },
  ]);

  assert.equal(plan.length, 3);
  assert.deepEqual(plan[0], {
    type: "collection",
    operator: "is",
    collectionId: "gid://shopify/Collection/100",
    title: "Summer",
    handle: "",
  });
  assert.deepEqual(plan[1], {
    type: "metafield",
    ownerType: "PRODUCT",
    operator: "equals",
    namespace: "custom",
    key: "material",
    value: "cotton",
  });
  assert.deepEqual(plan[2], {
    type: "metafield",
    ownerType: "VARIANT",
    operator: "contains",
    namespace: "spec",
    key: "country",
    value: "india",
  });
});

test("getProductPrismaWhere skips normalized fields and keeps native filters", () => {
  const where = getProductPrismaWhere(
    [
      { field: "vendor", operator: "equals", value: "Acme" },
      { field: "collections", operator: "contains", value: "Summer" },
      {
        field: "productMetafield",
        operator: "equals",
        namespace: "custom",
        key: "material",
        value: "cotton",
      },
    ],
    "demo.myshopify.com",
  );

  assert.equal(where.shop, "demo.myshopify.com");
  assert.equal(Array.isArray(where.AND), true);
  assert.equal(where.AND.length, 1);
  assert.deepEqual(where.AND[0], {
    vendor: { equals: "Acme", mode: "insensitive" },
  });
});

test("mergeResolvedIdSets intersects include filters and unions exclusions", () => {
  const merged = mergeResolvedIdSets([
    { operator: "contains", ids: ["p1", "p2", "p3"] },
    { operator: "equals", ids: ["p2", "p3", "p4"] },
    { operator: "is not", ids: ["p4", "p5"] },
  ]);

  assert.deepEqual(merged.includeIds.sort(), ["p2", "p3"]);
  assert.deepEqual(merged.excludeIds.sort(), ["p4", "p5"]);
});
