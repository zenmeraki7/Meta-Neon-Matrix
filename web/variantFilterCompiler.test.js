import test from "node:test";
import assert from "node:assert/strict";
import {
  compileVariantPrismaWhere,
  resolveVariantMetafieldMatchedVariantIds,
  splitProductAndVariantFilters,
} from "./services/productService/variantFilterCompiler.js";

function findClause(where, field) {
  return (where?.AND || []).find((clause) => Object.prototype.hasOwnProperty.call(clause || {}, field));
}

test("SKU filter compiles to case-insensitive contains", () => {
  const where = compileVariantPrismaWhere(
    [{ field: "sku", operator: "contains", value: "RED" }],
    "shop-a",
    "batch-a",
  );

  const skuClause = findClause(where, "sku");
  assert.ok(skuClause);
  assert.equal(skuClause.sku.contains, "RED");
  assert.equal(skuClause.sku.mode, "insensitive");
});

test("price filter compiles to decimal comparison", () => {
  const where = compileVariantPrismaWhere(
    [{ field: "price", operator: ">", value: "100" }],
    "shop-a",
    "batch-a",
  );

  const priceClause = findClause(where, "price");
  assert.ok(priceClause);
  assert.equal(priceClause.price.gt.toString(), "100");
});

test("product and variant filters split correctly", () => {
  const {
    productFilters,
    variantFilters,
    normalizedFilters,
  } = splitProductAndVariantFilters([
    { field: "vendor", operator: "equals", value: "Nike" },
    { field: "price", operator: ">", value: 100 },
  ]);

  assert.equal(productFilters.length, 1);
  assert.equal(productFilters[0].field, "vendor");
  assert.equal(variantFilters.length, 1);
  assert.equal(variantFilters[0].field, "price");
  assert.equal(normalizedFilters.length, 0);
});

test("option name/value filter compiles with product option name awareness", () => {
  const where = compileVariantPrismaWhere(
    [{ field: "option", optionName: "Color", operator: "equals", value: "Red" }],
    "shop-a",
    "batch-a",
  );

  const optionClause = (where?.AND || []).find((clause) => Array.isArray(clause?.OR));
  assert.ok(optionClause);
  assert.equal(optionClause.OR.length, 3);
  assert.equal(optionClause.OR[0].AND[1].product.option1Name.equals, "Color");
  assert.equal(optionClause.OR[1].AND[1].product.option2Name.equals, "Color");
  assert.equal(optionClause.OR[2].AND[1].product.option3Name.equals, "Color");
});

test("variant metafield resolver returns matched variant ids", async () => {
  const calls = [];
  const fakePrisma = {
    $queryRaw: async (...args) => {
      calls.push(args);
      return [{ id: "v1" }];
    },
  };

  const ids = await resolveVariantMetafieldMatchedVariantIds({
    prisma: fakePrisma,
    shop: "shop-a",
    mirrorBatchId: "batch-a",
    namespace: "custom",
    key: "material",
    operator: "equals",
    value: "cotton",
  });

  assert.deepEqual(ids, ["v1"]);
  assert.equal(calls.length, 1);
});
