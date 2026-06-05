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

test("session commit is CAS guarded and replayable after commit", () => {
  const repositorySource = read("web/repositories/sessionCommitRepository.js");
  const useCaseSource = read("web/useCases/commitBulkEditSessionUseCase.js");
  assert.ok(repositorySource.includes("AND status = 'DRAFT'"));
  assert.ok(repositorySource.includes('status === "COMMITTED"'));
  assert.ok(repositorySource.includes("alreadyCommitted: true"));
  assert.ok(useCaseSource.includes("changeCount: committed.changeCount"));
  assert.equal(repositorySource.includes("error.statusCode"), false);
});

test("bulk edit write enqueue is idempotent by shop and session", () => {
  const source = read("web/queues/adapters/bulkEditQueueAdapter.js");
  assert.ok(source.includes("pg_advisory_xact_lock"));
  assert.ok(source.includes("findBulkEditWriteJobBySession"));
  assert.ok(source.includes("meta->>'sessionId'"));
  assert.ok(source.includes("INSERT INTO sync_jobs"));
  assert.equal(source.includes("../../../db/syncJobs.js"), false);
  assert.equal(source.includes("createJob"), false);
});

test("session workflow controller maps service error codes to HTTP at the boundary", () => {
  const source = read("web/controllers/sessionWorkflowController.js");
  assert.ok(source.includes("statusCodeForSessionError"));
  assert.ok(source.includes('case "SESSION_NOT_FOUND"'));
  assert.ok(source.includes('case "NO_PENDING_CHANGES"'));
  assert.ok(source.includes('case "VALIDATION_FAILED"'));
});
