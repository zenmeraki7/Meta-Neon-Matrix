import test from "node:test";
import assert from "node:assert/strict";
import { buildCreateProductExportCommand } from "./normalizers/productExportCommandNormalizer.js";
import { fieldMappings } from "./utils/productExportUtils.js";

const context = {
  shop: "example.myshopify.com",
  idempotencyKey: "export-1",
};

const firstField = Object.keys(fieldMappings)[0];

function buildCommand(body) {
  return buildCreateProductExportCommand({
    ...context,
    body: {
      fields: [firstField],
      fileName: "export.csv",
      ...body,
    },
  });
}

test("product export command requires a safe csv filename", () => {
  assert.equal(buildCommand({ fileName: "products_2026-06-07.csv" }).fileName, "products_2026-06-07.csv");

  assert.throws(() => buildCommand({ fileName: "export" }), /Invalid fileName/);
  assert.throws(() => buildCommand({ fileName: "export.exe" }), /Invalid fileName/);
  assert.throws(() => buildCommand({ fileName: "export \\(copy\\).csv" }), /Invalid fileName/);
  assert.throws(() => buildCommand({ fileName: "export (copy).csv" }), /Invalid fileName/);
});

test("product export command bounds field count to the export registry", () => {
  const allFields = Object.keys(fieldMappings);
  const tooManyUniqueFields = [
    ...allFields,
    "ExtraExportField",
  ];

  assert.equal(buildCommand({ fields: allFields }).fields.length, allFields.length);
  assert.throws(
    () => buildCommand({ fields: tooManyUniqueFields }),
    /Invalid fields: too many fields/,
  );
});
