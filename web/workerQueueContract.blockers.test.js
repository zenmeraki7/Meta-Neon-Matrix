import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(file) {
  return fs.readFileSync(path.resolve(file), "utf8");
}

test("pipeline stage job ids include executionId", () => {
  const source = read("web/Jobs/Queues/bulkEditPipelineJob.js");
  assert.ok(source.includes('"bulk-edit-pipeline-freeze"'));
  assert.ok(source.includes('"bulk-edit-pipeline-plan"'));
  assert.ok(source.includes('"bulk-edit-pipeline-execute"'));
  assert.ok(source.includes("data.executionId"));
});

test("undo queue job id includes historyId + executionId + source", () => {
  const source = read("web/Jobs/Queues/bulkUndoJob.js");
  assert.ok(source.includes('joinSafeJobId('));
  assert.ok(source.includes("data?.historyId"));
  assert.ok(source.includes("data?.executionId"));
  assert.ok(source.includes("data?.source || \"default\""));
});

test("result ingestion uses authoritative Shopify fetch status", () => {
  const source = read("web/Jobs/Workers/bulkEditResultIngestWorker.js");
  assert.ok(source.includes("const status = String(fetched.status || \"\").toUpperCase();"));
  assert.equal(
    source.includes("const status = webhookStatus || fetched.status;"),
    false,
    "webhook status must not override fetched Shopify status",
  );
});

test("legacy bulk-edit queue consumer remains absent", () => {
  const workerSource = read("web/worker.js");
  assert.equal(
    workerSource.includes("bulkEditWorker.js"),
    false,
    "legacy bulk-edit worker import must stay absent",
  );
});
