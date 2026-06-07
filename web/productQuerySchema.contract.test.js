import test from "node:test";
import assert from "node:assert/strict";
import productQuerySchema from "./validations/productQuerySchema.js";

function validate(query) {
  return productQuerySchema.validate(query, { abortEarly: false });
}

test("product query schema bounds high-cost string and cursor inputs", () => {
  assert.equal(validate({ search: "shirt", title: "tee", cursor: "cursor-1" }).error, undefined);
  assert.match(validate({ search: "x".repeat(501) }).error?.message || "", /search/);
  assert.match(validate({ title: "x".repeat(501) }).error?.message || "", /title/);
  assert.match(validate({ description: "x".repeat(5001) }).error?.message || "", /description/);
  assert.match(validate({ cursor: "x".repeat(501) }).error?.message || "", /cursor/);
});

test("product query schema validates numeric ranges and sort options", () => {
  assert.equal(validate({ created_at_days: 3650, limit: 250, sortKey: "updatedAt", sortOrder: "desc" }).error, undefined);
  assert.match(validate({ created_at_days: 3651 }).error?.message || "", /created_at_days/);
  assert.match(validate({ limit: 251 }).error?.message || "", /limit/);
  assert.match(validate({ sortKey: "DROP TABLE" }).error?.message || "", /sortKey/);
});

test("product query schema rejects unknown query fields", () => {
  assert.match(validate({ unexpected: "field" }).error?.message || "", /unexpected/);
});
