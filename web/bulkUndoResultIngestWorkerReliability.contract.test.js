import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("bulk undo result ingest validates installed shop and shop-owned undo", () => {
  const worker = read("web/Jobs/Workers/bulkUndoResultIngestWorker.js");

  assert.match(worker, /db\.store\.findUnique/);
  assert.match(worker, /isUnInstalled: true/);
  assert.match(worker, /reason: "shop_not_installed"/);
  assert.match(worker, /db\.editHistory\.findFirst/);
  assert.match(worker, /reason: "undo_operation_not_found"/);
  assert.match(worker, /path: \["bulkOperationId"\]/);
});

test("bulk undo result ingest relies on fenced service idempotency", () => {
  const service = read("web/services/undo/UndoResultIngestionService.js");

  assert.match(service, /acquireOperationLease/);
  assert.match(service, /assertOperationLeaseOwnership/);
  assert.match(service, /where: \{\s*shop,/s);
  assert.match(service, /UNDO_ALREADY_TERMINAL/);
});

test("bulk undo result ingest normalizes external status at producer and worker", () => {
  const worker = read("web/Jobs/Workers/bulkUndoResultIngestWorker.js");
  const producer = read("web/Jobs/Queues/bulkUndoResultIngestJob.js");

  assert.match(worker, /VALID_BULK_STATUSES/);
  assert.match(worker, /Unexpected bulk operation status/);
  assert.match(worker, /fetchAuthoritativeBulkStatus/);
  assert.match(worker, /status: authoritativeStatus/);
  assert.match(worker, /!session\?\.accessToken/);
  assert.match(producer, /VALID_BULK_STATUSES/);
  assert.match(producer, /status,/);
});

test("bulk undo result ingest has lifecycle controls and DLQ", () => {
  const worker = read("web/Jobs/Workers/bulkUndoResultIngestWorker.js");

  assert.match(worker, /lockDuration:/);
  assert.match(worker, /\.on\("completed"/);
  assert.match(worker, /\.on\("failed"/);
  assert.match(worker, /\.on\("stalled"/);
  assert.match(worker, /bulkUndoResultIngestDlqQueue\.add/);
  assert.match(worker, /SIGTERM/);
});
