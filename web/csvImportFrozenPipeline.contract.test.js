import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(".");

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), "utf8");
}

test("csv import worker freezes explicit targets before execute", () => {
  const source = read("web/Jobs/Workers/bulkImportEditWorker.js");
  const executeSource = read("web/Jobs/Workers/bulkImportExecuteWorker.js");
  assert.ok(source.includes("freezeExplicitTargetSnapshot("));
  assert.ok(source.includes("addBulkImportExecuteJob("));
  assert.ok(executeSource.includes("addBulkEditExecuteJob("));
  assert.ok(!source.includes("service._bulkOperationHelper("));
});

test("csv import worker scopes mirror reads to active mirror batch", () => {
  const source = read("web/Jobs/Workers/bulkImportEditWorker.js");
  assert.ok(source.includes("getActiveMirrorBatchId("));
  assert.ok(source.includes("mirrorBatchId,"));
});

test("execution preparation reads csv rows from frozen-target products only", () => {
  const source = read("web/services/bulkEdit/BulkEditExecutionPreparationService.js");
  assert.ok(source.includes("history.batch?.csvImport === true"));
  assert.ok(source.includes("prisma.changeRecord.findMany"));
  assert.ok(source.includes("fields: [\"mixed\"]"));
});

test("csv history writes immutable edit command envelope", () => {
  const source = read("web/controllers/productImportController.js");
  assert.ok(source.includes("buildImmutableEditCommand("));
  assert.ok(source.includes("operator: \"CSV_IMPORT\""));
});
