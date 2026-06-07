import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  capLength,
  normalizeIntInRange,
  normalizeOptionalString,
  validateNoUnsafeNestedObjects,
  validateProductCursor,
} from "./normalizers/normalizerPrimitives.js";

const read = (file) => fs.readFileSync(path.resolve(file), "utf8");

test("normalizer primitives use strict plain object detection", () => {
  const source = read("web/normalizers/normalizerPrimitives.js");

  assert.ok(source.includes("Object.getPrototypeOf(value) === Object.prototype"));
});

test("normalizeIntInRange throws instead of silently clamping user input", () => {
  assert.equal(
    normalizeIntInRange(undefined, {
      fallback: 20,
      min: 1,
      max: 50,
      fieldName: "limit",
    }),
    20,
  );

  assert.throws(
    () => normalizeIntInRange(10_000, {
      fallback: 20,
      min: 1,
      max: 50,
      fieldName: "limit",
    }),
    (error) =>
      error.code === "VALIDATION_FAILED"
      && error.fields?.[0]?.field === "limit"
      && error.fields?.[0]?.error === "must be between 1 and 50",
  );

  assert.throws(
    () => normalizeIntInRange("10abc", {
      fallback: 20,
      min: 1,
      max: 50,
      fieldName: "limit",
    }),
    /Validation failed/,
  );
});

test("validateProductCursor rejects oversized cursor before decode", () => {
  assert.throws(
    () => validateProductCursor("x".repeat(501)),
    (error) => error.code === "INVALID_CURSOR",
  );
});

test("validateNoUnsafeNestedObjects collects every unsafe nested object", () => {
  assert.throws(
    () => validateNoUnsafeNestedObjects({
      first: {},
      second: [{ nested: {} }],
    }, "query"),
    (error) => {
      assert.equal(error.code, "VALIDATION_FAILED");
      assert.deepEqual(error.fields, [
        { field: "query", error: "unsafe nested object at first" },
        { field: "query", error: "unsafe nested object at second[0]" },
        { field: "query", error: "unsafe nested object at second[0].nested" },
      ]);
      return true;
    },
  );
});

test("capLength documents empty string behavior while optional strings return null", () => {
  assert.equal(capLength(null, 10, "name"), "");
  assert.equal(normalizeOptionalString(null, 10, "name"), null);
});
