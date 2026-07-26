import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const schema = fs.readFileSync(new URL("./prisma/schema.prisma", import.meta.url), "utf8");
const importHistoryService = fs.readFileSync(
  new URL("./services/historyService/importHistoryQueryService.js", import.meta.url),
  "utf8",
);

function modelBlock(name) {
  return schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] || "";
}

test("covered tenant-prefix indexes stay removed", () => {
  assert.doesNotMatch(modelBlock("EditHistory"), /@@index\(\[shop\]\)/);
  assert.doesNotMatch(modelBlock("Location"), /@@index\(\[shop\]\)/);
  assert.doesNotMatch(
    modelBlock("OperationLease"),
    /@@index\(\[shop, namespace\]\)/,
  );
  assert.doesNotMatch(
    modelBlock("OperationStageProgress"),
    /@@index\(\[shop, operationType, operationId\]\)/,
  );
});

test("spreadsheet history uses one stable cursor index and matching order", () => {
  const spreadsheetFile = modelBlock("SpreadsheetFile");
  assert.match(spreadsheetFile, /@@index\(\[shop, createdAt, id\]\)/);
  assert.doesNotMatch(spreadsheetFile, /@@index\(\[shop\]\)/);
  assert.match(
    importHistoryService,
    /orderBy:\s*\[\{ createdAt: "desc" \}, \{ id: "desc" \}\]/,
  );
});
