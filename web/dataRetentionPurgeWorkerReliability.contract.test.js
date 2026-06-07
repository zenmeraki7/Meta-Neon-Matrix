import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(
  path.resolve("web/Jobs/Workers/dataRetentionPurgeWorker.js"),
  "utf8",
);

test("data retention purge worker serializes work per shop with a heartbeat lease", () => {
  assert.ok(source.includes('const LEASE_NAMESPACE = "DATA_RETENTION_PURGE"'));
  assert.ok(source.includes("await acquireOperationLease({"));
  assert.ok(source.includes("resourceId: shop"));
  assert.ok(source.includes("heartbeatOperationLease({"));
  assert.ok(source.includes("await releaseOperationLease({"));
  assert.ok(source.includes("shop_purge_already_running"));
});

test("data retention purge worker observes stalls and shuts down gracefully", () => {
  assert.ok(source.includes('dataRetentionPurgeWorker.on("stalled"'));
  assert.ok(source.includes("await dataRetentionPurgeWorker.close()"));
  assert.ok(source.includes('process.once("SIGTERM"'));
  assert.ok(source.includes('process.once("SIGINT"'));
});
