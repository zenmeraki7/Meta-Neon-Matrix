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
  assert.ok(controller.includes("export const createCsvPreviewController = async (req, res) => {"));
  assert.ok(controller.includes("uploadToken: previewDoc.id"));
  assert.ok(controller.includes("buildPreviewResponse({ allItems, headers, cursor: 0, limit })"));
  assert.ok(controller.includes('const uploadToken = String(req.query?.uploadToken || "").trim();'));
  assert.ok(controller.includes("pageInfo: {"));
  assert.ok(controller.includes("nextCursor: hasNextPage ? encodeCursor(end) : null"));
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

