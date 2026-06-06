import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const worker = fs.readFileSync(
  path.resolve("web/Jobs/Workers/bulkEditVerificationWorker.js"),
  "utf8",
);
const service = fs.readFileSync(
  path.resolve("web/services/bulkEdit/BulkEditVerificationService.js"),
  "utf8",
);
const queues = fs.readFileSync(
  path.resolve("web/queues/adapters/jobsQueueInstancesAdapter.js"),
  "utf8",
);

test("verification worker guards installation, session, and concurrent completion", () => {
  assert.match(worker, /reason: "shop_not_installed"/);
  assert.match(worker, /SHOP_SESSION_NOT_AVAILABLE/);
  assert.match(worker, /acquireOperationLease\(\{/);
  assert.match(worker, /namespace: "BULK_EDIT_VERIFICATION"/);
  assert.match(worker, /reason: "verification_already_in_progress"/);
  assert.match(worker, /releaseOperationLease\(\{/);
  assert.match(worker, /reason: "already_verified_concurrent"/);
  assert.equal(worker.includes('reason: "already_verified"'), false);
  assert.match(worker, /new BulkEditVerificationService\(session\)/);
  assert.match(service, /constructor\(session\)/);
});

test("verification worker has operational telemetry and bounded execution settings", () => {
  assert.match(worker, /\.on\("completed"/);
  assert.match(worker, /\.on\("failed"/);
  assert.match(worker, /\.on\("error"/);
  assert.match(worker, /\.on\("stalled"/);
  assert.match(worker, /lockDuration:/);
  assert.match(worker, /stalledInterval:/);
  assert.match(worker, /maxStalledCount:/);
  assert.match(worker, /process\.once\("SIGTERM"/);
  assert.match(worker, /process\.once\("SIGINT"/);
});

test("verification retry exhaustion records a terminal state and dead-letter job", () => {
  assert.match(worker, /isRetryExhausted\(job\)/);
  assert.match(worker, /recordRetryExhausted\(\{/);
  assert.match(worker, /bulkEditVerificationDlqQueue\.add/);
  assert.match(worker, /executionState: OPERATION_LIFECYCLE_STATES\.FAILED/);
  assert.match(worker, /statusNormalized: "FAILED"/);
  assert.match(queues, /export const bulkEditVerificationDlqQueue = new Queue/);
});
