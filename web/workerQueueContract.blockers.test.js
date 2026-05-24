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

test("result ingest producer and worker require canonical bulkOperationId only", () => {
  const producerSource = read("web/Jobs/Queues/bulkEditResultIngestJob.js");
  const workerSource = read("web/Jobs/Workers/bulkEditResultIngestWorker.js");
  assert.ok(producerSource.includes("requires shop and bulkOperationId"));
  assert.equal(producerSource.includes("admin_graphql_api_id"), false);
  assert.equal(producerSource.includes("|| data?.id"), false);
  assert.equal(workerSource.includes("jobData.admin_graphql_api_id"), false);
  assert.equal(workerSource.includes("|| jobData.id"), false);
});

test("undo result ingest producer and worker require canonical bulkOperationId only", () => {
  const producerSource = read("web/Jobs/Queues/bulkUndoResultIngestJob.js");
  const workerSource = read("web/Jobs/Workers/bulkUndoResultIngestWorker.js");
  assert.ok(producerSource.includes("requires shop and bulkOperationId"));
  assert.equal(producerSource.includes("admin_graphql_api_id"), false);
  assert.equal(producerSource.includes("|| data?.id"), false);
  assert.equal(workerSource.includes("admin_graphql_api_id"), false);
});

test("legacy bulk-edit queue consumer remains absent", () => {
  const workerSource = read("web/worker.js");
  assert.equal(
    workerSource.includes("bulkEditWorker.js"),
    false,
    "legacy bulk-edit worker import must stay absent",
  );
});

test("pipeline execute dispatch and execute-worker requeue use bulk-edit-execute queue helper", () => {
  const pipelineSource = read("web/Jobs/Workers/bulkEditPipelineWorker.js");
  const executeSource = read("web/Jobs/Workers/bulkEditExecuteWorker.js");
  const executeQueueSource = read("web/Jobs/Queues/bulkEditExecuteJob.js");

  assert.ok(pipelineSource.includes("addBulkEditExecuteJob("));
  assert.ok(executeSource.includes("addBulkEditExecuteJob("));
  assert.ok(executeQueueSource.includes("BULK_EDIT_EXECUTE_QUEUE"));
  assert.equal(
    pipelineSource.includes("addbulkEditJob("),
    false,
    "pipeline worker must not enqueue execute jobs through legacy bulk-edit queue helper",
  );
  assert.equal(
    executeSource.includes("addbulkEditJob("),
    false,
    "execute worker requeues must not use legacy bulk-edit queue helper",
  );
});
