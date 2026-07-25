import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const previewTableSource = readFileSync(
  new URL("./Domain/Spreadsheet/components/CsvPreviewTable.jsx", import.meta.url),
  "utf8",
);
const spreadsheetPageSource = readFileSync(
  new URL("./Domain/Spreadsheet/pages/Spreadsheet.jsx", import.meta.url),
  "utf8",
);
const csvParserSource = readFileSync(
  new URL("./Domain/Spreadsheet/utils/csvParser.js", import.meta.url),
  "utf8",
);

test("CSV preview table keeps hooks before empty-preview return", () => {
  const memoIndex = previewTableSource.indexOf(
    "const pageRows = useMemo(() => (Array.isArray(rows) ? rows : []), [rows]);",
  );
  const emptyReturnIndex = previewTableSource.indexOf(
    "if (!headers.length && !loading) return null;",
  );

  assert.notEqual(memoIndex, -1, "pageRows memo hook must exist");
  assert.notEqual(emptyReturnIndex, -1, "empty preview guard must exist");
  assert.ok(
    memoIndex < emptyReturnIndex,
    "useMemo must run before the CSV-empty return so upload does not add a hook on later renders",
  );
});

test("CSV preview table does not create hooks per dynamic CSV column or row", () => {
  assert.doesNotMatch(
    previewTableSource,
    /headers\.map\([\s\S]*?\buse(State|Effect|Memo|Callback|Ref|Reducer)\s*\(/,
    "headers.map must not contain hooks because CSV column count is dynamic",
  );
  assert.doesNotMatch(
    previewTableSource,
    /pageRows\.map\([\s\S]*?\buse(State|Effect|Memo|Callback|Ref|Reducer)\s*\(/,
    "pageRows.map must not contain hooks because CSV row count is dynamic",
  );
});

test("spreadsheet page uses hook-backed authenticated API client", () => {
  assert.match(
    spreadsheetPageSource,
    /const apiClient = useApiClient\(\);/,
    "Spreadsheet route should use the hook-backed authenticated API client",
  );
  assert.doesNotMatch(
    spreadsheetPageSource,
    /protectedApiRequest/,
    "Spreadsheet route should not depend on the global authenticated fetch registry",
  );
});

test("spreadsheet CSV preview creation sends an idempotency key", () => {
  assert.match(
    spreadsheetPageSource,
    /\/api\/products\/csv\/preview\?limit=\$\{PREVIEW_PAGE_SIZE\}`,\s*\{\s*method: "POST",\s*idempotent: true,/,
    "CSV preview POST must be idempotent because the server requires Idempotency-Key",
  );
});

test("spreadsheet import redirects to edit history operation id", () => {
  assert.match(
    spreadsheetPageSource,
    /const historyId = result\?\.operationId \|\| result\?\.id;/,
    "CSV import should derive the history route id from operationId",
  );
  assert.match(
    spreadsheetPageSource,
    /navigate\(`\/editDetails\/\$\{encodeURIComponent\(historyId\)\}`\);/,
    "CSV import should navigate to the edit history details route",
  );
  assert.doesNotMatch(
    spreadsheetPageSource,
    /navigate\(["']\/editDetails\/["'] \+ result\.importId\)/,
    "CSV import must not navigate to SpreadsheetFile importId",
  );
});

test("spreadsheet import payload uses explicit CSV mappings instead of forcing first columns", () => {
  assert.match(
    csvParserSource,
    /export function buildImportColumnMappings\(headers = \[\], columnMappings = \{\}\)/,
    "CSV parser should expose a final import mapping builder",
  );
  assert.doesNotMatch(
    csvParserSource,
    /mappings\[firstHeader\] = "id";/,
    "Final import mappings must not silently treat the first displayed column as Product ID",
  );
  assert.doesNotMatch(
    previewTableSource,
    /if \(index === 0\) forcedValue = "id";/,
    "CSV preview must not force the first displayed column to Product ID",
  );
  assert.match(
    spreadsheetPageSource,
    /JSON\.stringify\(effectiveMappings\)/,
    "CSV import request must submit validated effective mappings, not raw UI state",
  );
  assert.doesNotMatch(
    spreadsheetPageSource,
    /hasProductIdMapping\(effectiveMappings\)/,
    "CSV import should allow create rows when Product ID is not mapped",
  );
  assert.match(
    spreadsheetPageSource,
    /onClick=\{handleOpenConfirm\}/,
    "CSV import should open confirmation through a named handler",
  );
  assert.doesNotMatch(
    spreadsheetPageSource,
    /onClick=\{\(\) => setConfirmOpen\(true\)\}/,
    "CSV import must not open confirmation without validation",
  );
});
