import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(
  path.resolve("web/queues/adapters/bulkEditVerificationQueueAdapter.js"),
  "utf8",
);

test("verification enqueue persists an intent before generic dispatch", () => {
  const intentIndex = source.indexOf("await db.operationEnqueueIntent.upsert");
  const dispatchIndex = source.indexOf("await JobCreationService.dispatchIntent(intent)");
  assert.ok(intentIndex >= 0);
  assert.ok(dispatchIndex > intentIndex);
  assert.ok(source.includes('status: "PENDING"'));
  assert.ok(source.includes("shop_queueKey_dedupeKey"));
  assert.ok(source.includes("pendingRecovery: !dispatched"));
  assert.ok(source.includes('status: "DISPATCH_FAILED"'));
  assert.equal(source.includes(".add("), false);
});

test("verification enqueue remains deterministic and observes missing execution identity", () => {
  assert.ok(source.includes("jobId: requestedJobId"));
  assert.ok(source.includes("dedupeKey: jobId"));
  assert.ok(source.includes("history-${safeHistoryId}"));
  assert.ok(source.includes("Verification enqueue called without execution identity"));
  assert.equal(source.includes('executionId || "default"'), false);
});

test("verification enqueue treats first intent options as canonical", () => {
  assert.ok(source.includes("const { jobId: requestedJobId, ...restOptions } = options"));
  assert.ok(source.includes("First-write-wins"));
  assert.ok(source.includes("update: {}"));
});

test("verification adapter does not construct BullMQ queues during module import", () => {
  assert.equal(source.includes('from "bullmq"'), false);
  assert.equal(source.includes("new Queue("), false);
});
