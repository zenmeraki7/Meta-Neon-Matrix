import test from "node:test";
import assert from "node:assert/strict";
import { productExportSchema } from "./validations/productExportQuerySchema.js";
import { fieldMappings } from "./utils/productExportUtils.js";

const firstColumn = Object.keys(fieldMappings)[0];
const validFilter = { field: "title", operator: "contains", value: "shirt" };

function validate(payload) {
  return productExportSchema.validate(payload, { abortEarly: false });
}

test("product export schema bounds columns and filter params", () => {
  const base = {
    columns: [firstColumn],
    filterParams: [validFilter],
    filename: "products.csv",
  };
  assert.equal(validate(base).error, undefined);
  assert.match(validate({ ...base, columns: [] }).error?.message || "", /columns/);
  assert.match(
    validate({ ...base, filterParams: Array.from({ length: 501 }, () => validFilter) }).error?.message || "",
    /filterParams/,
  );
});

test("product export schema rejects malformed filters, filenames, and unknown fields", () => {
  const base = {
    columns: [firstColumn],
    filterParams: [validFilter],
    filename: "products.csv",
  };
  assert.match(validate({ ...base, filename: "../products.csv" }).error?.message || "", /filename/);
  assert.match(
    validate({ ...base, filterParams: [{ ...validFilter, extra: true }] }).error?.message || "",
    /extra/,
  );
  assert.match(validate({ ...base, unexpected: true }).error?.message || "", /unexpected/);
});
