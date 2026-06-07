import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("bulk edit and undo suspend and delay requeue on Shopify circuit open", () => {
  const edit = read("web/Jobs/Workers/bulkEditExecuteWorker.js");
  const undo = read("web/Jobs/Workers/bulkUndoWorker.js");

  for (const source of [edit, undo]) {
    assert.match(source, /executeWithShopifyCircuit/);
    assert.match(source, /error instanceof CircuitOpenError/);
    assert.match(source, /reason: "SHOPIFY_UNAVAILABLE"/);
    assert.match(source, /suspended: true/);
    assert.match(source, /delay: delayMs/);
  }
  assert.match(edit, /suspendBulkEditForShopifyOutage/);
  assert.match(undo, /suspendBulkUndoForShopifyOutage/);
});

test("suspended operations are resumable lifecycle states", () => {
  const lifecycle = read("web/services/operationLifecycleStateMachine.js");
  const execute = read("web/Jobs/Workers/bulkEditExecuteWorker.js");
  const undoRepository = read("web/repositories/bulkUndoExecutionRepository.js");

  assert.match(lifecycle, /SUSPENDED: "SUSPENDED"/);
  assert.match(lifecycle, /SUSPENDED: \["QUEUED", "EXECUTING"/);
  assert.match(execute, /OPERATION_LIFECYCLE_STATES\.SUSPENDED/);
  assert.match(undoRepository, /BULK_UNDO_STATES\.SUSPENDED/);
});
