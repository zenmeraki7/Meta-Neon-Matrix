import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(".");
const worker = fs.readFileSync(
  path.join(root, "web/Jobs/Workers/bulkImportEditWorker.js"),
  "utf8",
);
const targeting = fs.readFileSync(
  path.join(root, "web/services/productService/productTargetingService.js"),
  "utf8",
);
const queues = fs.readFileSync(
  path.join(root, "web/queues/adapters/jobsQueueInstancesAdapter.js"),
  "utf8",
);
const executeWorker = fs.readFileSync(
  path.join(root, "web/Jobs/Workers/bulkImportExecuteWorker.js"),
  "utf8",
);

test("bulk import validates owned CSV paths before opening them", () => {
  assert.ok(worker.includes("function assertSafeFilePath("));
  assert.ok(worker.includes("path.relative(UPLOAD_BASE, resolved)"));
  assert.ok(worker.includes("IMPORT_FILE_OWNERSHIP_MISMATCH"));
  assert.ok(worker.includes("fs.createReadStream(safeFilePath)"));
  assert.ok(!worker.includes("fs.createReadStream(filePath)"));
});

test("bulk import processes bounded product, database, and write chunks", () => {
  assert.ok(worker.includes("PRODUCT_CHUNK_SIZE"));
  assert.ok(worker.includes("processProductChunk({"));
  assert.ok(worker.includes("id: { in: productIds }"));
  assert.ok(worker.includes("select: productDiffSelect"));
  assert.ok(worker.includes("createMany({ data: changeRecords, skipDuplicates: true })"));
  assert.ok(!worker.includes("include: { variants: true }"));
});

test("bulk import retries processing histories and preserves retryable files", () => {
  assert.ok(worker.includes('status === "processing" && job.attemptsMade > 0'));
  assert.ok(worker.includes("willExhaustRetryFromProcessor(job)"));
  assert.ok(worker.includes("cleanupFile = cleanupFile && terminalFailure"));
  assert.ok(worker.includes("finally {"));
});

test("bulk import uses deterministic batches and append-safe snapshot chunks", () => {
  assert.ok(worker.includes("executionId || history.executionIdentity || historyId"));
  assert.ok(worker.includes("freezeChangeRecordTargets({"));
  assert.ok(worker.includes("replaceExisting: offset === 0"));
  assert.ok(targeting.includes("replaceExisting = true"));
  assert.ok(targeting.includes("ordinalOffset = 0"));
  assert.ok(targeting.includes("ordinal: ordinalOffset + index"));
});

test("bulk import has one safe failed listener, DLQ, and lifecycle controls", () => {
  assert.equal(worker.match(/bulkImportEditWorker\.on\("failed"/g)?.length, 1);
  assert.ok(worker.includes("void recordRetryExhausted({"));
  assert.ok(worker.includes("bulkImportEditDlqQueue.add("));
  assert.ok(worker.includes("lockDuration:"));
  assert.ok(worker.includes('process.once("SIGTERM"'));
  assert.ok(worker.includes('process.once("SIGINT"'));
  assert.ok(queues.includes("export const bulkImportEditDlqQueue"));
});

test("bulk import preparation hands off execution to a retry-safe bridge worker", () => {
  assert.ok(worker.includes("addBulkImportExecuteJob("));
  assert.ok(!worker.includes("addBulkEditExecuteJob("));
  assert.ok(executeWorker.includes("addBulkEditExecuteJob("));
  assert.ok(executeWorker.includes("OPERATION_LIFECYCLE_STATES.TARGET_FROZEN"));
  assert.ok(executeWorker.includes("OPERATION_LIFECYCLE_STATES.PLANNED"));
  assert.ok(executeWorker.includes("IMPORT_EXECUTE_HANDOFF_TRANSITION_CONFLICT"));
  assert.equal(executeWorker.match(/bulkImportExecuteWorker\.on\("failed"/g)?.length, 1);
  assert.ok(queues.includes("export const bulkImportExecuteQueue"));
  assert.ok(queues.includes("export const bulkImportExecuteDlqQueue"));
});
