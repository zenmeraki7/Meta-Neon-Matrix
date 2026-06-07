import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(
  path.resolve("web/Jobs/Workers/verificationResumeWorker.js"),
  "utf8",
);

test("verification resume worker requeues VERIFYING jobs stale for ten minutes", () => {
  assert.ok(source.includes("const STUCK_AFTER_MS = 10 * 60 * 1000"));
  assert.ok(source.includes("executionState: OPERATION_LIFECYCLE_STATES.VERIFYING"));
  assert.ok(source.includes("updatedAt: { lt: cutoff }"));
  assert.ok(source.includes("enqueueBulkEditVerification("));
  assert.ok(source.includes('repeat: { every: REPEAT_EVERY_MS }'));
});

test("verification resume worker terminally times out jobs beyond twice the timeout", () => {
  assert.ok(source.includes("const HARD_TIMEOUT_MS = VERIFICATION_TIMEOUT_MS * 2"));
  assert.ok(source.includes("startedAt: { lt: hardTimeoutCutoff }"));
  assert.ok(source.includes("OPERATION_LIFECYCLE_STATES.VERIFICATION_TIMEOUT"));
  assert.ok(source.includes("expectedExecutionStates: [OPERATION_LIFECYCLE_STATES.VERIFYING]"));
  assert.ok(source.includes('stageStatus: "FAILED"'));
});

test("verification resume worker watches stale SHOPIFY_COMPLETED jobs", () => {
  assert.ok(source.includes("executionState: OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED"));
  assert.ok(source.includes("executionState: true"));
  assert.ok(source.includes("enqueueBulkEditVerification("));
});
