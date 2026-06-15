import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function read(filePath) {
  return fs.readFileSync(path.join(ROOT, filePath), "utf8");
}

test("manual undo supports direct execution records without frozen snapshot sets", () => {
  const service = read("web/services/productService/productBulkUndoService.js");
  const repository = read("web/repositories/bulkUndoExecutionRepository.js");
  const worker = read("web/Jobs/Workers/bulkUndoWorker.js");

  assert.equal(
    service.includes('throw new Error("FROZEN_SNAPSHOT_SET_REQUIRED_FOR_UNDO")'),
    false,
    "Undo request must not fail immediately when direct execution has no frozen snapshot set",
  );
  assert.ok(
    service.includes('snapshotSource = "change_record_before_values"'),
    "Undo service should fall back to trusted ChangeRecord before-values",
  );
  assert.ok(
    repository.includes('"succeeded"'),
    "Undo worker lookup should include lowercase direct-execution success statuses",
  );
  assert.ok(
    service.includes("record?.variantFieldChanges"),
    "Replay generation should accept direct ChangeRecord variantFieldChanges",
  );
  assert.ok(
    worker.includes('snapshotSource = "change_record_before_values"'),
    "Worker should execute the direct ChangeRecord fallback path",
  );
  assert.ok(
    worker.includes("snapshotSetId\n        ? undoReplayProducts.filter"),
    "Worker should only enforce snapshot target identity matching when a snapshot set exists",
  );
});
