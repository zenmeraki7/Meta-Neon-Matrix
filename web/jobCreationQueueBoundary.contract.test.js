import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOTS = ["web/controllers", "web/services", "web/repositories", "web/useCases"];
const ALLOWED = new Set([
  path.resolve("web/services/JobCreationService.js"),
]);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && entry.name.endsWith(".js") ? [full] : [];
  });
}

test("operation creation layers never call BullMQ queue.add directly", () => {
  const violations = ROOTS.flatMap((root) => walk(path.resolve(root)))
    .filter((file) => !ALLOWED.has(file))
    .filter((file) => /\b[A-Za-z_$][\w$]*Queue\.add\s*\(/.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(
    violations,
    [],
    `Use JobCreationService.createAndEnqueue instead: ${violations.join(", ")}`,
  );
});

test("JobCreationService atomically creates intent and keeps dispatch failures recoverable", () => {
  const source = fs.readFileSync(path.resolve("web/services/JobCreationService.js"), "utf8");
  assert.ok(source.includes("static async createAndEnqueue"));
  assert.ok(source.includes("await db.$transaction(async (tx) =>"));
  assert.ok(source.includes("tx.operationEnqueueIntent.upsert"));
  assert.ok(source.includes('status: "PENDING"'));
  assert.ok(source.includes('status: "DISPATCHED"'));
  assert.ok(source.includes('status: "DISPATCH_FAILED"'));
  assert.ok(source.includes("joinSafeJobId(queueName, shopId, jobId)"));
  assert.ok(source.includes("idempotencyKey = null"));
  assert.ok(source.includes("FOR UPDATE"));
  assert.ok(source.includes("pendingRecovery: !dispatched"));
  assert.ok(source.includes('String(intent.status || "").toUpperCase() === "DISPATCHED"'));
  assert.ok(source.includes("Queue accepted job but DISPATCHED intent status update failed"));
  assert.ok(source.includes("Failed to persist enqueue intent dispatch failure"));
  assert.equal(source.includes("executionState: OPERATION_LIFECYCLE_STATES.FAILED"), false);
});

test("JobCreationService replays an existing bulk-write job before requiring pending rows", () => {
  const source = fs.readFileSync(path.resolve("web/services/JobCreationService.js"), "utf8");
  const existingLookup = source.indexOf("meta->>'sessionId'");
  const pendingCount = source.indexOf("SELECT COUNT(*)::int AS count");
  assert.ok(existingLookup >= 0);
  assert.ok(pendingCount >= 0);
  assert.ok(existingLookup < pendingCount);
});

test("manual bulk-edit creation forwards its required idempotency key", () => {
  const source = fs.readFileSync(
    path.resolve("web/services/bulkEdit/BulkEditCommandService.js"),
    "utf8",
  );
  const creationCall = source.slice(
    source.indexOf("JobCreationService.createAndEnqueue"),
    source.indexOf("const historyId = created.jobRecord.id"),
  );
  assert.ok(creationCall.includes("idempotencyKey,"));
});
