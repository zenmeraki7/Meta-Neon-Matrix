import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("bulk undo fences accepted Shopify submissions for reconciliation", () => {
  const worker = read("web/Jobs/Workers/bulkUndoWorker.js");
  const repository = read("web/repositories/bulkUndoExecutionRepository.js");
  const ingestion = read("web/services/undo/UndoResultIngestionService.js");

  assert.match(worker, /markUndoReconcileSubmitted/);
  assert.match(worker, /BULK_UNDO_RECONCILE_SUBMITTED_AFTER_TRANSITION_FAILURE/);
  assert.match(repository, /BULK_UNDO_STATES\.RECONCILE_SUBMITTED/);
  assert.match(repository, /reconcileReason: "SUBMITTED_BUT_LOCAL_TRANSITION_FAILED"/);
  assert.match(ingestion, /BULK_UNDO_STATES\.RECONCILE_SUBMITTED/);
});

test("bulk undo checks all active Shopify mutation states and session token", () => {
  const worker = read("web/Jobs/Workers/bulkUndoWorker.js");

  assert.match(worker, /new Set\(\["CREATED", "RUNNING", "CANCELING"\]\)/);
  assert.match(worker, /getCurrentBulkOperationStatus\(session, "MUTATION"\)/);
  assert.match(worker, /!session\?\.accessToken/);
  assert.match(worker, /isShopifyAuthError/);
});

test("bulk undo conflict confirmation is a resumable business outcome", () => {
  const worker = read("web/Jobs/Workers/bulkUndoWorker.js");
  const repository = read("web/repositories/bulkUndoExecutionRepository.js");
  const projection = read("web/services/historyStatusProjectionService.js");

  assert.match(worker, /moveUndoToAwaitingConfirmation/);
  assert.match(worker, /reason: "undo_conflict_requires_confirmation"/);
  assert.match(worker, /error: "UNDO_CONFLICT_REQUIRES_CONFIRMATION"/);
  assert.match(repository, /BULK_UNDO_STATES\.AWAITING_CONFIRMATION/);
  assert.match(projection, /undo_awaiting_confirmation/);
});

test("bulk undo validates producer payload and has lifecycle controls with DLQ", () => {
  const worker = read("web/Jobs/Workers/bulkUndoWorker.js");
  const producer = read("web/Jobs/Queues/bulkUndoJob.js");

  assert.match(producer, /RAW_TARGETING_PAYLOAD_FORBIDDEN/);
  assert.match(worker, /error\.nonRetryable = true/);
  assert.match(worker, /lockDuration:/);
  assert.match(worker, /bulkUndoDlqQueue\.add/);
  assert.match(worker, /\.on\("stalled"/);
  assert.match(worker, /SIGTERM/);
});

test("bulk undo result ingestion re-enqueues continuation pages", () => {
  const ingestion = read("web/services/undo/UndoResultIngestionService.js");

  assert.match(ingestion, /if \(hasMore\)/);
  assert.match(ingestion, /await addbulkUndoJob/);
  assert.match(ingestion, /source: "undo_webhook_continuation"/);
});
