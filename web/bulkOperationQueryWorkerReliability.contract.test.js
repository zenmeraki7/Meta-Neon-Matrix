import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("bulk operation query validates installed shop and query sync ownership", () => {
  const worker = read("web/Jobs/Workers/bulkOperationQueryWorker.js");

  assert.match(worker, /db\.store\.findUnique/);
  assert.match(worker, /reason: "shop_not_installed"/);
  assert.match(worker, /db\.syncHistory\.findFirst/);
  assert.match(worker, /QUERY_SYNC_OPERATION_TYPES/);
  assert.match(worker, /\["Product", "Collection", "ProductType"\]/);
  assert.match(worker, /SYNC_RECORD_NOT_FOUND_FOR_BULK_OPERATION/);
  assert.match(worker, /already_terminal:/);
});

test("bulk operation query handler already performs atomic ingestion claim and status fetch", () => {
  const handler = read("web/helpers/webhookHelpers/bulkOperations/productTypeSync.js");

  assert.match(handler, /Atomic claim/);
  assert.match(handler, /stage: "MIRROR_DOWNLOAD_STARTED"/);
  assert.match(handler, /fetchBulkOperationDetails/);
  assert.match(handler, /bulkOperation\.status !== "COMPLETED"/);
});

test("bulk operation query has one safe failed listener and lifecycle controls", () => {
  const worker = read("web/Jobs/Workers/bulkOperationQueryWorker.js");

  assert.equal((worker.match(/\.on\("failed"/g) || []).length, 1);
  assert.doesNotMatch(worker, /logWebhookError/);
  assert.match(worker, /bulkOperationQueryDlqQueue\.add/);
  assert.match(worker, /lockDuration:/);
  assert.match(worker, /\.on\("stalled"/);
  assert.match(worker, /SIGTERM/);
});

test("bulk query recovery enqueues deduplicated worker jobs", () => {
  const worker = read("web/Jobs/Workers/bulkOperationQueryWorker.js");
  const recovery = worker.slice(worker.indexOf("export async function recoverCompletedProductBulkOperations"));

  assert.match(recovery, /addbulkOperatonQueryJob/);
  assert.match(recovery, /jobId: `recovery:/);
  assert.doesNotMatch(recovery, /await handleSyncOperation/);
});
