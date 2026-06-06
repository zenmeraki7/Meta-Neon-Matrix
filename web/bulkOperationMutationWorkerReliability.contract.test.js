import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("bulk operation mutation validates installed shop before routing", () => {
  const worker = read("web/Jobs/Workers/bulkOperationMutationWorker.js");

  assert.match(worker, /db\.store\.findUnique/);
  assert.match(worker, /isUnInstalled: true/);
  assert.match(worker, /reason: "shop_not_installed"/);
});

test("bulk operation mutation resolves undo ownership with one shop-scoped query", () => {
  const worker = read("web/Jobs/Workers/bulkOperationMutationWorker.js");
  const helper = worker.slice(
    worker.indexOf("async function hasUndoOwnerForBulkOperation"),
    worker.indexOf("function buildUnresolvedBulkWebhookDeliveryId"),
  );

  assert.equal((helper.match(/db\.editHistory\.findFirst/g) || []).length, 1);
  assert.match(helper, /OR: \[/);
  assert.match(helper, /undoBulkOperationId === String\(bulkOperationId\)/);
});

test("unresolved mutation persistence uses stable hash and non-retryable collision", () => {
  const worker = read("web/Jobs/Workers/bulkOperationMutationWorker.js");

  assert.match(worker, /sha256Stable\(payload \|\| \{\}\)/);
  assert.doesNotMatch(worker, /\.update\(JSON\.stringify\(payload/);
  assert.match(worker, /collision\.nonRetryable = true/);
});

test("bulk operation mutation has one safe failed listener and lifecycle controls", () => {
  const worker = read("web/Jobs/Workers/bulkOperationMutationWorker.js");

  assert.equal((worker.match(/\.on\("failed"/g) || []).length, 1);
  assert.doesNotMatch(worker, /logWebhookError/);
  assert.match(worker, /bulkOperationMutationDlqQueue\.add/);
  assert.match(worker, /lockDuration:/);
  assert.match(worker, /\.on\("stalled"/);
  assert.match(worker, /SIGTERM/);
});

test("non-mutation and unresolved routes use consistent skipped results", () => {
  const worker = read("web/Jobs/Workers/bulkOperationMutationWorker.js");

  assert.match(worker, /reason: "non_mutation_type"/);
  assert.match(worker, /reason: "unresolved_bulk_operation_owner_persisted"/);
  assert.doesNotMatch(worker, /ignored: true/);
});
