import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  assertSupportedExportFields,
  buildExportCsvHeaders,
  buildExportCsvRow,
  sanitizeCsvCell,
} from "./services/productService/productExportFieldRegistry.js";

const root = import.meta.dirname;
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test('export fields ["title", "tags"] pass product validation', () => {
  const fields = assertSupportedExportFields(["title", "tags"], {
    targetGranularity: "PRODUCT",
  });

  assert.deepEqual(fields.map((field) => field.key), ["title", "tags"]);
  assert.deepEqual(buildExportCsvHeaders(fields), ["Title", "Tags"]);
});

test("unknown export field rejects with allowed fields", () => {
  assert.throws(
    () => assertSupportedExportFields(["notReal"], { targetGranularity: "PRODUCT" }),
    (error) =>
      error.code === "VALIDATION_FAILED" &&
      error.message === "Unsupported export field: notReal" &&
      Array.isArray(error.allowedFields) &&
      error.allowedFields.includes("title"),
  );
});

test("duplicate export field rejects after alias normalization", () => {
  assert.throws(
    () => assertSupportedExportFields(["seoTitle", "metaTitle"], { targetGranularity: "PRODUCT" }),
    /Duplicate export field: metaTitle/,
  );
});

test("variant-only field rejects for product granularity", () => {
  assert.throws(
    () => assertSupportedExportFields(["sku"], { targetGranularity: "PRODUCT" }),
    /Unsupported export field for PRODUCT export: sku/,
  );
});

test("CSV cells preserve text and prevent formula injection", () => {
  assert.equal(sanitizeCsvCell("hello, \"world\"\nnext"), "hello, \"world\"\nnext");
  assert.equal(sanitizeCsvCell("=SUM(A1:A2)"), "'=SUM(A1:A2)");
  assert.equal(sanitizeCsvCell("+cmd"), "'+cmd");
  assert.equal(sanitizeCsvCell("-10"), "'-10");
  assert.equal(sanitizeCsvCell("@name"), "'@name");
});

test("CSV rows use stable registry headers", () => {
  const fields = assertSupportedExportFields(["title", "tags"], {
    targetGranularity: "PRODUCT",
  });
  const row = buildExportCsvRow({
    fieldDefinitions: fields,
    product: {
      title: "celestial, starlight",
      tags: ["new", "arrived"],
    },
  });

  assert.deepEqual(row, {
    Title: "celestial, starlight",
    Tags: "new, arrived",
  });
});

test("frontend export field selector reads backend registry endpoint", () => {
  const page = read("frontend/Domain/products/exports/pages/ExportPage.jsx");

  assert.match(page, /\/api\/products\/export\/fields\?targetGranularity=/);
  assert.match(page, /setExportFields/);
  assert.match(page, /fallbackFields/);
});

test("product export creation freezes mirror DB targets", () => {
  const service = read("services/productService/productExportService.js");

  assert.match(service, /TargetingEngineService\.resolveAndFreezeExportTargets/);
  assert.doesNotMatch(service, /adminGraphql|shopify\.api|Admin API/i);
});
