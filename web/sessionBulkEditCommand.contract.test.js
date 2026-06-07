import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (p) => fs.readFileSync(path.resolve(p), "utf8");

test("legacy session route service delegates to hardened use cases", () => {
  const source = read("web/services/bulkEdit/bulkEditSessionRouteService.js");
  assert.ok(source.includes("commitBulkEditSessionUseCase"));
  assert.ok(source.includes("stageSessionChangesUseCase"));
  assert.ok(source.includes("applyColumnSessionChanges"));
  assert.equal(source.includes("../../../db/syncJobs.js"), false);
  assert.equal(source.includes("commitSession("), false);
  assert.equal(source.includes("countRowsByStatus"), false);
  assert.equal(source.includes("columnApplyFanout("), false);
});

test("session change use cases validate staged and column-applied changes", () => {
  const source = read("web/useCases/sessionChangeUseCases.js");
  assert.ok(source.includes("MAX_SESSION_CHANGE_BATCH_SIZE"));
  assert.ok(source.includes("validateSessionChanges(changes)"));
  assert.ok(source.includes("validateColumnApplyCommand"));
  assert.ok(source.includes("unknown field"));
  assert.ok(source.includes("nested objects are not allowed"));
  assert.ok(source.includes("must be a numeric string"));
  assert.equal(source.includes("return toSessionChangeResultDto({ staged: changes.length })"), false);
  assert.equal(source.includes("error.statusCode"), false);
});

test("session commit atomically creates a recoverable dispatch intent", () => {
  const serviceSource = read("web/services/JobCreationService.js");
  const useCaseSource = read("web/useCases/commitBulkEditSessionUseCase.js");
  assert.ok(serviceSource.includes("await db.$transaction(async (tx) =>"));
  assert.ok(serviceSource.includes("tx.operationEnqueueIntent.upsert"));
  assert.ok(serviceSource.includes('status: "PENDING"'));
  assert.ok(serviceSource.includes('status: "DISPATCH_FAILED"'));
  assert.ok(useCaseSource.includes("JobCreationService.createAndEnqueue"));
  assert.ok(useCaseSource.includes("idempotencyKey:"));
  assert.ok(useCaseSource.includes("command.idempotencyKey || `bulk-write:"));
  assert.ok(useCaseSource.includes("sessionId: command.sessionId"));
  assert.ok(useCaseSource.includes('wrapped.code = "BULK_WRITE_JOB_CREATION_FAILED"'));
  assert.ok(useCaseSource.includes("wrapped.statusCode = 503"));
  assert.ok(useCaseSource.includes("wrapped.retryable = true"));
});

test("bulk edit write enqueue is idempotent by shop and session", () => {
  const source = read("web/services/JobCreationService.js");
  assert.ok(source.includes("meta->>'sessionId'"));
  assert.ok(source.includes("FOR UPDATE"));
  assert.ok(source.includes("INSERT INTO sync_jobs"));
  assert.ok(source.includes("shop_queueKey_dedupeKey"));
  assert.ok(source.includes('`${type}:${shop}:${jobRecord.sessionId}`'));
  assert.ok(source.includes("idempotencyKey: safeIdempotencyKey"));
  assert.ok(source.includes("metafield-bulk-write") === false);
});

test("session workflow controller maps service error codes to HTTP at the boundary", () => {
  const source = read("web/controllers/sessionWorkflowController.js");
  assert.ok(source.includes("statusCodeForSessionError"));
  assert.ok(source.includes('case "SESSION_NOT_FOUND"'));
  assert.ok(source.includes('case "NO_PENDING_CHANGES"'));
  assert.ok(source.includes('case "VALIDATION_FAILED"'));
  assert.ok(source.includes('case "BULK_WRITE_JOB_CREATION_FAILED"'));
  assert.ok(source.includes("return 503"));
  assert.ok(source.includes("retryable: Boolean(error.retryable)"));
});
