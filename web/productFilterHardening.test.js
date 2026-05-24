import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPrismaCollectionFilter,
  getProductPrismaWhere,
} from "./services/productService/productFilterCompiler.js";
import { normalizeProductStatus } from "./utils/productStatus.js";

test("collection fallback compiler path is disabled", () => {
  assert.throws(
    () => buildPrismaCollectionFilter("is", "Summer"),
    /must use normalized ProductCollection targeting path/i,
  );
});

test("option_value_1 requires paired option_name_1 filter", () => {
  assert.throws(
    () =>
      getProductPrismaWhere(
        [{ field: "option_value_1", operator: "is", value: "Medium" }],
        "shop-a",
      ),
    /option_value_1 requires option_name_1/i,
  );
});

test("paired option_name + option_value compiles", () => {
  const where = getProductPrismaWhere(
    [
      { field: "option_name_1", operator: "is", value: "Size" },
      { field: "option_value_1", operator: "is", value: "Medium" },
    ],
    "shop-a",
  );

  assert.ok(where?.AND?.length >= 2);
});

test("status filter compiles with normalized+raw transition fallback", () => {
  const where = getProductPrismaWhere(
    [{ field: "status", operator: "is", value: "active" }],
    "shop-a",
  );

  const statusClause = where.AND.find((clause) => Array.isArray(clause?.OR));
  assert.ok(statusClause);
  assert.equal(statusClause.OR[0].statusNormalized.equals, "ACTIVE");
  assert.equal(statusClause.OR[1].status.equals, "ACTIVE");
});

test("normalizeProductStatus maps unknown status to UNKNOWN", () => {
  assert.equal(normalizeProductStatus("active"), "ACTIVE");
  assert.equal(normalizeProductStatus("archived"), "ARCHIVED");
  assert.equal(normalizeProductStatus("anything-else"), "UNKNOWN");
});
