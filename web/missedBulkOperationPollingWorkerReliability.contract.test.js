import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(
  path.resolve("web/Jobs/Workers/missedBulkOperationPollingWorker.js"),
  "utf8",
);

test("missed webhook polling gives active result ingestion a longer stale window", () => {
  assert.ok(source.includes("const RUNNING_STALE_AFTER_MS = 2 * 60 * 1000"));
  assert.ok(source.includes("const INGESTING_STALE_AFTER_MS = 10 * 60 * 1000"));
  assert.ok(source.includes("executionState: OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING"));
  assert.ok(source.includes("updatedAt: { lt: runningCutoff }"));
  assert.ok(source.includes("executionState: OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS"));
  assert.ok(source.includes("updatedAt: { lt: ingestingCutoff }"));
});

test("missed webhook polling scans past cooldown rows while bounding Shopify calls", () => {
  assert.ok(source.includes("const CANDIDATE_SCAN_LIMIT = 250"));
  assert.ok(source.includes("const POLL_LIMIT = 50"));
  assert.ok(source.includes("take: CANDIDATE_SCAN_LIMIT"));
  assert.ok(source.includes("for (const history of candidates) {\n    if (polled >= POLL_LIMIT) break"));
  assert.ok(source.includes("return { scanned, polled, enqueued, skipped }"));
});

test("missed webhook polling normalizes undo routing signals", () => {
  assert.ok(source.includes("type: true"));
  assert.ok(source.includes('String(history.type || "").trim().toUpperCase() === "UNDO"'));
  assert.ok(source.includes('undoStatus === "processing" && undoState === "awaiting_shopify"'));
});

test("missed webhook polling has stalled telemetry and graceful shutdown", () => {
  assert.ok(source.includes('.on("stalled"'));
  assert.ok(source.includes("await missedBulkOperationPollingWorker.close()"));
  assert.ok(source.includes('process.once("SIGTERM"'));
  assert.ok(source.includes('process.once("SIGINT"'));
  assert.equal(source.includes("enqueuePollingJob"), false);
  assert.equal(source.includes("enqueueMissedBulkOperationPollingJob"), false);
});

test("verification recovery remains the single owner of post-ingestion recovery", () => {
  const verificationResume = fs.readFileSync(
    path.resolve("web/Jobs/Workers/verificationResumeWorker.js"),
    "utf8",
  );

  assert.ok(verificationResume.includes("OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED"));
  assert.ok(verificationResume.includes("OPERATION_LIFECYCLE_STATES.VERIFYING"));
  assert.ok(verificationResume.includes("const HARD_TIMEOUT_MS = VERIFICATION_TIMEOUT_MS * 2"));
  assert.equal(source.includes("enqueueBulkEditVerification"), false);
});
