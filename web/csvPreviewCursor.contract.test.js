import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(file) {
  return fs.readFileSync(path.resolve(file), "utf8");
}

test("csv preview route exposes POST upload-token bootstrap and GET cursor page fetch", () => {
  const routes = read("web/routes/productRoutes.js");
  assert.ok(
    routes.includes('router.post("/csv/preview", subscriptionMiddleware, uploadCsv.single("file"), createCsvPreviewController);'),
    "CSV preview POST bootstrap route is required",
  );
  assert.ok(
    routes.includes('router.get("/csv/preview", subscriptionMiddleware, previewCsvController);'),
    "CSV preview GET cursor route is required",
  );
});

test("csv preview controller returns cursor-paged rows and supports upload token bootstrap", () => {
  const controller = read("web/controllers/productImportController.js");
  const service = read("web/services/productImport/productImportPreviewService.js");
  assert.ok(controller.includes("export const createCsvPreviewController = async (req, res) => {"));
  assert.ok(controller.includes("createCsvPreview({"));
  assert.ok(service.includes("uploadToken: previewDoc.id"));
  assert.ok(service.includes("buildPreviewResponse({"));
  assert.ok(service.includes("cursor: 0"));
  assert.ok(service.includes("pageInfo: {"));
  assert.ok(service.includes("nextCursor: hasNextPage ? encodeCursor(end) : null"));
});

test("spreadsheet preview table renders only server response rows without local hard cap slicing", () => {
  const previewTable = read("web/frontend/Domain/Spreadsheet/components/CsvPreviewTable.jsx");
  const spreadsheetPage = read("web/frontend/Domain/Spreadsheet/pages/Spreadsheet.jsx");

  assert.equal(
    previewTable.includes("LOCAL_PREVIEW_MAX_ROWS"),
    false,
    "CSV preview table must not apply local max-row caps",
  );
  assert.equal(
    previewTable.includes("parsedData.slice("),
    false,
    "CSV preview table must not slice local parsed data",
  );

  assert.ok(
    spreadsheetPage.includes("setPreviewRows(items)"),
    "Spreadsheet page must render rows from server response",
  );
  assert.ok(
    spreadsheetPage.includes("setPreviewUploadToken(result?.uploadToken || null)"),
    "Spreadsheet page must persist preview upload token for cursor traversal",
  );
  assert.ok(
    spreadsheetPage.includes("params.set(\"cursor\", cursor)"),
    "Spreadsheet page must request cursor pages from server",
  );
});

test("csv preview parser uses a realistic synchronous parse timeout guard", () => {
  const service = read("web/services/productImport/productImportPreviewService.js");

  assert.ok(
    service.includes("DEFAULT_PREVIEW_PARSE_TIMEOUT_MS = 15_000"),
    "CSV preview must not use a 1.5 second default timeout for valid merchant files",
  );
  assert.ok(
    service.includes("CSV_PREVIEW_PARSE_TIMEOUT_MS"),
    "CSV preview timeout must remain configurable",
  );
  assert.equal(
    service.includes("Promise.race(["),
    false,
    "Papa.parse is synchronous here, so Promise.race cannot enforce this timeout",
  );
});

