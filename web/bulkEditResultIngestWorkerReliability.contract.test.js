import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const worker = fs.readFileSync(
  path.resolve("web/Jobs/Workers/bulkEditResultIngestWorker.js"),
  "utf8",
);
const service = fs.readFileSync(
  path.resolve("web/services/bulkEdit/BulkEditResultIngestionService.js"),
  "utf8",
);

test("result ingest worker refreshes state after acquiring its lease", () => {
  const leaseIndex = worker.indexOf("const ingestLease = await acquireOperationLease");
  const refreshIndex = worker.indexOf(
    "const leasedHistory = await findHistoryByBulkOperation",
  );
  assert.ok(leaseIndex > -1);
  assert.ok(refreshIndex > leaseIndex);
  assert.match(worker, /reason: "edit_history_not_found_after_lease"/);
});

test("result ingest uses authoritative URLs and classifies missing auth", () => {
  assert.match(worker, /!session\?\.accessToken/);
  assert.match(worker, /SHOPIFY_AUTH_REVOKED/);
  assert.match(worker, /err\?\.name === "UnrecoverableError"/);
  const fetchedUrlIndex = worker.indexOf("fetched.url", worker.indexOf("const resultUrl"));
  const payloadUrlIndex = worker.indexOf(
    "resolveResultUrl(job.data || {})",
    worker.indexOf("const resultUrl"),
  );
  assert.ok(fetchedUrlIndex > -1 && fetchedUrlIndex < payloadUrlIndex);
});

test("result ingest observes lease loss and retries verification enqueue failures", () => {
  assert.match(worker, /INGEST_LEASE_LOST_BEFORE_INGESTION/);
  assert.match(worker, /leaseLostAfterIngest: true/);
  assert.match(worker, /VERIFICATION_ENQUEUE_FAILED_AFTER_INGESTION/);
  assert.equal(worker.includes("verificationQueueFailed: true"), false);
});

test("result ingest service reuses an externally-owned worker lease", () => {
  assert.match(service, /leaseOwnerId: externalLeaseOwnerId = null/);
  assert.match(service, /const ownsLease = !externalLeaseOwnerId/);
  assert.match(service, /await assertOperationLeaseOwnership\(\{/);
  assert.match(worker, /leaseOwnerId: ingestLeaseOwnerId/);
});
