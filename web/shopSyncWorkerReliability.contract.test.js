import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("shop sync uses shared renewable Redis lock helpers", () => {
  const source = read("web/Jobs/Workers/shopSyncWorker.js");

  assert.doesNotMatch(source, /import crypto from/);
  assert.match(source, /acquireRedisLock/);
  assert.match(source, /renewRedisLock/);
  assert.match(source, /releaseRedisLock/);
  assert.match(source, /clearInterval\(submissionLockHeartbeat\)/);
  assert.match(source, /releaseExclusiveShopWork\(exclusiveShopLockKey\)\.catch/);
});

test("shop sync scopes store lookup to both shop id and URL", () => {
  const source = read("web/Jobs/Workers/shopSyncWorker.js");

  assert.match(source, /db\.store\.findFirst\(\{\s*where: \{\s*id: shopId,\s*shopUrl: shop,/s);
  assert.doesNotMatch(source, /actualShopUrl/);
});

test("shop sync marks reconciliation pending only after Shopify slot check", () => {
  const source = read("web/Jobs/Workers/shopSyncWorker.js");

  assert.ok(source.indexOf("ACTIVE_BULK_OPERATION_STATUSES.has(status)") < source.indexOf("markInventoryReconciliationPending(shop)"));
  assert.ok(source.indexOf("ACTIVE_BULK_OPERATION_STATUSES.has(status)") < source.indexOf("markCollectionReconciliationPending(shop)"));
});

test("shop sync completion event does not claim mirror ingest completion", () => {
  const source = read("web/Jobs/Workers/shopSyncWorker.js");
  const completedHandler = source.slice(
    source.indexOf('shopSyncWorker.on("completed"'),
    source.indexOf("let shuttingDown"),
  );

  assert.doesNotMatch(completedHandler, /lastFullSyncAt/);
  assert.doesNotMatch(completedHandler, /mirrorReconcileSignal/);
});

test("shop sync relies on submit fence and shared retry exhaustion helper", () => {
  const source = read("web/Jobs/Workers/shopSyncWorker.js");

  assert.doesNotMatch(source, /function willExhaustRetry/);
  assert.match(source, /retryable && !willExhaustRetryFromProcessor\(job\)/);
  assert.equal((source.match(/existingSubmission/g) || []).length, 0);
});

test("worker telemetry separates processor and failed-event retry semantics", () => {
  const source = read("web/utils/workerTelemetry.js");

  assert.match(source, /isRetryExhausted[\s\S]*attemptsMade[\s\S]*>= attempts/);
  assert.match(source, /willExhaustRetryFromProcessor[\s\S]*getJobAttempt\(job\) >= attempts/);
});
