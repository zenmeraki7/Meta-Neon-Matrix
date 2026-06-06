import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("product sync acquires Redis serialization before the database claim", () => {
  const source = read("web/Jobs/Workers/productSyncWorker.js");
  const syncStore = source.slice(source.indexOf("async function syncStore"), source.indexOf("const schedulerProcessor"));

  assert.ok(syncStore.indexOf("acquireShopLock(shopUrl)") < syncStore.indexOf("claimStoreSync(shopUrl)"));
  assert.match(syncStore, /catch \(error\) \{\s*await releaseShopLock\(shopLock\);\s*throw error;/s);
});

test("product sync non-retryable errors use BullMQ UnrecoverableError", () => {
  const source = read("web/Jobs/Workers/productSyncWorker.js");

  assert.match(source, /import \{ QueueEvents, UnrecoverableError, Worker \} from "bullmq"/);
  assert.match(source, /throw new UnrecoverableError\(error\.message\)/);
  assert.match(source, /err\?\.name === "UnrecoverableError"/);
  assert.doesNotMatch(source, /job\.discard\(\)/);
});

test("stale recovery does not report timed-out Shopify work as completed", () => {
  const source = read("web/Jobs/Workers/productSyncWorker.js");

  assert.match(source, /shopifyBulkJobCompleted: false/);
  assert.match(source, /renewRedisLock\(\{/);
});

test("product sync reconcile-submitted operations have an explicit recovery path", () => {
  const source = read("web/Jobs/Workers/operationEnqueueIntentRecoveryWorker.js");

  assert.match(source, /operationType: "PRODUCT_SYNC"/);
  assert.match(source, /status: "RECONCILE_SUBMITTED"/);
  assert.match(source, /status: "RUNNING"/);
  assert.match(source, /productSyncsReconciled/);
});

test("product sync enqueue failures preserve shop context", () => {
  const source = read("web/Jobs/Workers/productSyncWorker.js");

  assert.match(source, /error\.shopUrl = store\.shopUrl/);
  assert.match(source, /shop: settled\.reason\?\.shopUrl/);
  assert.doesNotMatch(source, /ALL_STORES_SYNC_BATCH_SIZE/);
  assert.doesNotMatch(source, /AUTO_SYNC_BATCH_SIZE/);
  assert.doesNotMatch(source, /PRIORITY_SYNC_BATCH_SIZE/);
  assert.doesNotMatch(source, /syncAllStoresBatched/);
});
