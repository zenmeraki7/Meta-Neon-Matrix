import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSearch } from "./http/queryNormalizers.js";
import { validateCategoryQuery } from "./validators/categoryRequestValidator.js";
import { validateCollectionQuery } from "./validators/collectionRequestValidator.js";

test("normalizeSearch accepts an explicit max length", () => {
  assert.equal(normalizeSearch("  Summer\u0000   Sale  ", 20), "Summer Sale");

  assert.throws(
    () => normalizeSearch("x".repeat(101), 100),
    (error) =>
      error.code === "VALIDATION_ERROR"
      && error.message === "Invalid query: search must be <= 100 chars",
  );
});

test("category and collection validators delegate search length to normalizeSearch", () => {
  assert.throws(
    () => validateCategoryQuery({ search: "x".repeat(101) }),
    /search must be <= 100 chars/,
  );

  assert.throws(
    () => validateCollectionQuery({ search: "x".repeat(101) }),
    /search must be <= 100 chars/,
  );
});

test("category and collection query validators still return frozen normalized output", () => {
  const category = validateCategoryQuery({ search: "  Hats  ", limit: "10" });
  const collection = validateCollectionQuery({ cursor: "abc", limit: "5" });

  assert.deepEqual(category, { search: "Hats", limit: 10, cursor: undefined });
  assert.deepEqual(collection, { search: "", limit: 5, cursor: "abc" });
  assert.equal(Object.isFrozen(category), true);
  assert.equal(Object.isFrozen(collection), true);
});
