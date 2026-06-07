import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("metafield writes reclaim stale writing rows and batch ledger transitions", () => {
  const worker = read("web/Jobs/Workers/metafieldBulkWriteWorker.js");
  const ledger = read("web/db/bulkEditChanges.js");

  assert.match(ledger, /writing_started_at/);
  assert.match(ledger, /METAFIELD_WRITING_STALE_MINUTES/);
  assert.match(ledger, /status = 'ERROR' AND bec\.retryable = true/);
  assert.match(worker, /markRowsWriting/);
  assert.match(worker, /const claimedBatch = batch\.filter/);
  assert.match(worker, /markRowsWritten/);
  assert.match(worker, /markRowsError/);
  assert.doesNotMatch(worker, /markRowWriting/);
});

test("metafield preflight correlates Shopify nodes by id", () => {
  const worker = read("web/Jobs/Workers/metafieldBulkWriteWorker.js");

  assert.match(worker, /const nodeById = new Map/);
  assert.match(worker, /nodeById\.get\(expected\.shopifyMetafieldId\)/);
  assert.doesNotMatch(worker, /const node = nodes\[i\]/);
});

test("metafield repeated execution is idempotent and input validation is complete", () => {
  const worker = read("web/Jobs/Workers/metafieldBulkWriteWorker.js");

  assert.match(worker, /countLedgerRows/);
  assert.match(worker, /reason: "all_rows_already_processed"/);
  assert.match(worker, /MISSING_SHOPIFY_OWNER_ID/);
  assert.match(worker, /MISSING_NAMESPACE/);
  assert.match(worker, /MISSING_KEY/);
  assert.match(worker, /MISSING_TYPE/);
  assert.match(worker, /MISSING_NEW_VALUE/);
  assert.doesNotMatch(worker, /export async function runMetafieldBulkWrite/);
});

test("metafield worker has structured lifecycle logging and DLQ", () => {
  const worker = read("web/Jobs/Workers/metafieldBulkWriteWorker.js");

  assert.doesNotMatch(worker, /console\.error/);
  assert.match(worker, /lockDuration:/);
  assert.match(worker, /\.on\("completed"/);
  assert.match(worker, /\.on\("failed"/);
  assert.match(worker, /\.on\("stalled"/);
  assert.match(worker, /metafieldBulkWriteDlqQueue\.add/);
  assert.match(worker, /SIGTERM/);
});

test("metafieldsSet uses the shared shop budget and returns throttled rows to pending", () => {
  const worker = read("web/Jobs/Workers/metafieldBulkWriteWorker.js");
  const ledger = read("web/db/bulkEditChanges.js");

  assert.match(worker, /getBudgetManager\(resolvedShop\)/);
  assert.match(worker, /budget\.executeWithBudget\(50/);
  assert.match(worker, /isThrottleError\(error\)/);
  assert.match(worker, /await markRowsRetryable/);
  assert.match(ledger, /export async function markRowsRetryable/);
  assert.match(ledger, /status = 'PENDING'/);
  assert.match(ledger, /SET edit_status = 'PENDING'/);
  assert.match(worker, /const METAFIELDS_SET_BATCH_SIZE = 25/);
});
