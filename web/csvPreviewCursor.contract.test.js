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
  const previewService = read("web/services/productImport/productImportPreviewService.js");
  const dto = read("web/dtos/productImportDto.js");

  assert.ok(controller.includes("export const createCsvPreviewController = async (req, res) => {"));
  assert.ok(controller.includes("const result = await createCsvPreview(command);"));
  assert.ok(controller.includes("const result = await previewCsvPage(command);"));
  assert.ok(controller.includes("toCsvPreviewResponseDto(result)"));
  assert.ok(controller.includes("toCsvPreviewPageDto(result)"));
  assert.ok(previewService.includes("uploadToken: previewDoc.id"));
  assert.ok(previewService.includes("pageInfo: {"));
  assert.ok(previewService.includes("nextCursor: hasNextPage ? encodeCursor(end) : null"));
  assert.ok(dto.includes("items: data.items"));
  assert.ok(dto.includes("pageInfo: data.pageInfo"));
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
