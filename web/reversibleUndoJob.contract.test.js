import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

const schema = read("web/prisma/schema.prisma");
const service = read("web/services/productService/productBulkUndoService.js");
const worker = read("web/Jobs/Workers/bulkUndoWorker.js");
const results = read("web/services/undo/UndoResultIngestionService.js");
const repository = read("web/repositories/bulkUndoExecutionRepository.js");

test("undo creates a linked first-class EditHistory and per-record reversible ledger", () => {
  assert.match(schema, /sourceEditHistoryId\s+String\?/);
  assert.match(schema, /undoEditHistoryId\s+String\?\s+@unique/);
  assert.match(schema, /attemptCount\s+Int\s+@default\(0\)/);
  assert.match(schema, /retryable\s+Boolean\s+@default\(true\)/);
  assert.match(schema, /writingStartedAt\s+DateTime\?/);
  assert.match(schema, /appliedAt\s+DateTime\?/);
  assert.match(service, /type: "UNDO"/);
  assert.match(service, /sourceEditHistoryId: historyId/);
  assert.match(service, /prepareUndoChangeRecords/);
  assert.match(service, /db\.changeRecord\.createMany/);
  assert.ok(service.indexOf("db.changeRecord.createMany") < service.indexOf("async undoEditBulkOperation"));
});

test("undo before-values come from the active mirror and MIRROR_MISSING is persisted", () => {
  assert.match(service, /db\.product\.findMany/);
  assert.match(service, /db\.variant\.findMany/);
  assert.match(service, /beforeValues:/);
  assert.match(service, /missingMirror \? "MIRROR_MISSING"/);
  assert.match(service, /failureCode,/);
  assert.match(service, /Current mirror value required for undo was not found/);
  assert.match(service, /Phase 1 source-of-truth:[\s\S]*never from a live Shopify read/);
  assert.match(service, /Post-original-write drift check only[\s\S]*value_before[\s\S]*must never populate[\s\S]*beforeValues/);
  assert.ok(worker.indexOf("prepareUndoChangeRecords") < worker.indexOf("verifyUndoConflicts"));
  assert.ok(worker.indexOf("prepareUndoChangeRecords") < worker.indexOf("undoEditBulkOperation"));
});

test("undo conflict verification compares Shopify current values to mirror value_before", () => {
  assert.match(service, /expectedBefore = fieldChange\?\.oldValue \?\? fieldChange\?\.newValue/);
  assert.match(service, /String\(current\) !== String\(expectedBefore\)/);
  assert.match(service, /Array\.isArray\(variantChange\?\.changes\) \? variantChange\.changes : \[variantChange\]/);
  assert.doesNotMatch(service, /const expectedAfter =/);
});

test("undo queueing completes idempotency with scoped shop", () => {
  assert.match(service, /idempotencyStore\.complete\(\{[\s\S]*shop: this\.session\.shop/);
  assert.doesNotMatch(service, /recordId: begin\.recordId,\s*shop,/);
});

test("undo change-record preparation has a durable resumable state", () => {
  assert.match(service, /BULK_UNDO_STATES\.CHANGE_RECORDS_PENDING/);
  assert.match(repository, /markUndoChangeRecordsPrepared/);
  assert.match(repository, /findExistingUndoChangeRecords/);
  assert.match(repository, /findPendingUndoChangeRecords/);
  assert.match(repository, /BULK_UNDO_STATES\.CHANGE_RECORDS_PENDING/);
  assert.ok(worker.indexOf("await findPendingUndoChangeRecords") < worker.indexOf("await findSuccessfulChangeRecords"));
  assert.match(worker, /targetIdentities: pendingUndoRecords\.map\(\(record\) => record\.targetIdentity\)/);
  assert.ok(worker.indexOf("await findExistingUndoChangeRecords") < worker.indexOf("await service.prepareUndoChangeRecords"));
  assert.ok(worker.indexOf("await service.prepareUndoChangeRecords") < worker.indexOf("await markUndoChangeRecordsPrepared"));
  assert.ok(worker.indexOf("await markUndoChangeRecordsPrepared") < worker.indexOf("await beginEditHistoryStage"));
});

test("undo conflict chunks are replaced atomically", () => {
  assert.match(repository, /prisma\.\$transaction\(async \(tx\) =>/);
  assert.ok(repository.indexOf("await tx.undoOperationConflictChunk.deleteMany") < repository.indexOf("await tx.undoOperationConflictChunk.createMany"));
  assert.doesNotMatch(repository, /await prisma\.undoOperationConflictChunk\.deleteMany/);
});

test("missing undo before-values fail one replay record instead of throwing the batch", () => {
  assert.match(service, /failureCode: "UNDO_BEFORE_VALUES_REQUIRED"/);
  assert.match(service, /failureMessage: "Undo before-values were missing for this target"/);
  assert.doesNotMatch(service, /throw error;\s*\n\s*}\s*\n\s*return \{\s*\.\.\.record,\s*productFieldChanges: beforeProductFieldChanges/);
});

test("partial undo results split APPLIED and FAILED rows and replay excludes APPLIED", () => {
  assert.match(results, /status: "APPLIED"[\s\S]*mirrorStatus: "MIRROR_PENDING"/);
  assert.match(results, /appliedAt/);
  assert.match(results, /retryable: false/);
  assert.match(results, /status: "FAILED"/);
  assert.match(results, /failedByMessage/);
  assert.match(results, /productId: \{ in: appliedIds \}/);
  assert.match(results, /await db\.\$transaction\(writes\)/);
  assert.doesNotMatch(results, /no-await-in-loop/);
  assert.match(results, /where: \{[\s\S]*status: "PENDING"/);
  assert.doesNotMatch(service, /failureCode: \{ not: "MIRROR_MISSING" \}/);
  assert.match(worker, /filter\(\(record\) => String\(record\.status\)\.toUpperCase\(\) === "PENDING"\)/);
});

test("undo result ingestion asserts lease immediately before row persistence", () => {
  const assertIndex = results.indexOf("await assertOperationLeaseOwnership({", results.indexOf("UNDO_EDIT_HISTORY_ID_REQUIRED"));
  const persistIndex = results.indexOf("await persistUndoResultRows({");
  assert.ok(assertIndex > -1);
  assert.ok(persistIndex > -1);
  assert.ok(assertIndex < persistIndex);
  assert.equal(results.slice(assertIndex, persistIndex).includes('namespace: "BULK_UNDO_RESULT_INGEST"'), true);
});

test("undo result ingestion does not mark rows applied for zero-submission no-url completion", () => {
  assert.match(results, /expectedSubmittedCount = 0/);
  assert.match(results, /Number\(expectedSubmittedCount \|\| 0\) <= 0[\s\S]*return \{ count: 0 \}/);
  assert.match(results, /expectedSubmittedCount: batchTargetCount/);
});

test("undo completion reconciles already-completed transition and still updates UndoOperation", () => {
  assert.match(results, /const completionResult = await db\.\$transaction\(async \(tx\) =>/);
  assert.match(results, /const existingUndo = normalizeUndoState\(existing\?\.undo, \{\}\)/);
  assert.match(results, /String\(existingUndo\.state \|\| ""\) !== BULK_UNDO_STATES\.COMPLETED/);
  assert.match(results, /await tx\.undoOperation\.updateMany/);
  assert.match(results, /reason: "undo_already_completed"/);
});

test("undo submission increments ChangeRecord attempts before Shopify write", () => {
  assert.match(service, /attemptCount: \{ increment: 1 \}/);
  assert.match(service, /writingStartedAt: new Date\(\)/);
  assert.match(worker, /undoEditBulkOperation\([\s\S]*\{ undoEditHistoryId \}/);
});

test("undo of undo reads APPLIED source records and reverses from their before-values", () => {
  assert.match(repository, /"SUCCESS", "VERIFIED", "APPLIED"/);
  assert.match(worker, /sourceIsUndo/);
  assert.match(worker, /plannedMutation: record\.afterValues/);
  assert.match(worker, /beforeValues: record\.beforeValues/);
  assert.match(service, /undo: buildPlannedUndoState\(\{ allowed: true \}\)/);
});
