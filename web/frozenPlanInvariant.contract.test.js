import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), "utf8");
}

test("execute path does not resolve targets from filters after freeze", () => {
  const source = read("web/services/bulkEdit/BulkEditExecutionPreparationService.js");
  const executeWorker = read("web/Jobs/Workers/bulkEditExecuteWorker.js");
  assert.equal(
    source.includes("resolveAndFreezeExecutionTargets"),
    false,
    "Execution preparation must not call target resolvers after freeze",
  );
  assert.equal(
    source.includes("getFrozenTargetProductIds("),
    false,
    "Execution preparation must read from frozen snapshot set rows",
  );
  assert.equal(
    source.includes("getFrozenTargetVariantIds("),
    false,
    "Execution preparation must read from frozen snapshot set rows",
  );
  assert.equal(
    source.includes("listFrozenSnapshotItemsPage("),
    true,
    "Execution preparation must consume frozen snapshot set items",
  );
  assert.equal(
    executeWorker.includes("productFilterCompiler"),
    false,
    "Execute worker must not import product filter compiler",
  );
  assert.equal(
    executeWorker.includes("variantFilterCompiler"),
    false,
    "Execute worker must not import variant filter compiler",
  );
  assert.equal(
    executeWorker.includes("resolveCanonicalProductTarget"),
    false,
    "Execute worker must not import target resolver paths",
  );
});

test("undo path reads only frozen successful rows", () => {
  const worker = read("web/Jobs/Workers/bulkUndoWorker.js");
  const service = read("web/services/productService/productBulkUndoService.js");
  const repository = read("web/repositories/bulkUndoExecutionRepository.js");

  assert.equal(worker.includes("prisma[legacySnapshotModel]"), false);
  assert.equal(
    repository.includes("prisma.targetSnapshotItem.findMany("),
    true,
    "Undo worker must read TargetSnapshotItem rows",
  );
  assert.equal(
    repository.includes('executionStatus: "SUCCEEDED"'),
    true,
    "Undo worker must only consider successful frozen rows",
  );
  assert.equal(
    service.includes('snapshotSource = "target_snapshot"'),
    true,
    "Undo service must identify the frozen snapshot source when present",
  );
});
