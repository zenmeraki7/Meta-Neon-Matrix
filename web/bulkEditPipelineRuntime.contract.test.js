import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(".");

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), "utf8");
}

test("worker boot imports execute, ingest, and verification workers", () => {
  const source = read("web/worker.js");
  assert.ok(source.includes("./Jobs/Workers/bulkEditExecuteWorker.js"));
  assert.ok(source.includes("./Jobs/Workers/bulkEditResultIngestWorker.js"));
  assert.ok(source.includes("./Jobs/Workers/bulkEditVerificationWorker.js"));
});

test("worker boot starts autorun-disabled bulk edit execute worker", () => {
  const workerBootSource = read("web/worker.js");
  const executeWorkerSource = read("web/Jobs/Workers/bulkEditExecuteWorker.js");

  assert.ok(executeWorkerSource.includes("autorun: false"));
  assert.ok(executeWorkerSource.includes("export function startBulkEditExecuteWorker()"));
  assert.ok(workerBootSource.includes("startBulkEditExecuteWorker()"));
});

test("scheduled edit worker does not call legacy updateProducts path", () => {
  const source = read("web/Jobs/Workers/scheduledEditWorker.js");
  assert.ok(!source.includes("updateProducts("));
  assert.ok(source.includes("enqueueBulkEditTargetFreezeJob("));
});

test("manual execute response contains stable id and operationId", () => {
  const source = read("web/services/bulkEdit/BulkEditCommandService.js");
  assert.ok(source.includes("id: historyId"));
  assert.ok(source.includes("operationId: historyId"));
});

test("frontend execute uses locationId and accepts operationId fallback", () => {
  const source = read("web/frontend/Domain/products/edit/pages/EditPreviewPage.jsx");
  assert.ok(source.includes("locationId: locationValue"));
  assert.ok(source.includes("json.id || json.operationId"));
});

test("pause state normalizes to PAUSED instead of QUEUED", () => {
  const source = read("web/services/operationPauseResumeService.js");
  assert.ok(source.includes("executionState: OPERATION_LIFECYCLE_STATES.PAUSED"));
  assert.ok(source.includes("normalizeEditHistoryExecutionState(\n          OPERATION_LIFECYCLE_STATES.PAUSED"));
});

