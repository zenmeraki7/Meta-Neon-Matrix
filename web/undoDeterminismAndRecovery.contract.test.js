import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (p) => fs.readFileSync(path.resolve(p), "utf8");

test("undo operation and chunk models exist in prisma schema", () => {
  const schema = read("web/prisma/schema.prisma");
  assert.ok(schema.includes("model UndoOperation"));
  assert.ok(schema.includes("model UndoItem"));
  assert.ok(schema.includes("model UndoOperationConflictChunk"));
  assert.ok(schema.includes("@@unique([shop, idempotencyKeyHash])"));
  const operation = schema.match(/model UndoOperation\s*\{[\s\S]*?\n\}/)?.[0] || "";
  assert.equal(operation.includes("@@unique([shop, sourceEditHistoryId])"), false);
  assert.ok(schema.includes("@@unique([shop, undoOperationId, chunkType, chunkIndex])"));
});

test("bulk undo worker persists chunked safe/conflict subsets", () => {
  const src = read("web/Jobs/Workers/bulkUndoWorker.js");
  const repo = read("web/repositories/bulkUndoExecutionRepository.js");
  assert.ok(src.includes("persistUndoConflictChunks"));
  assert.ok(repo.includes("UndoOperationConflictChunk"));
  assert.ok(repo.includes("CONFLICT_CHUNK_SIZE"));
});

test("undo result ingestion uses fenced lease transitions", () => {
  const src = read("web/services/undo/UndoResultIngestionService.js");
  assert.ok(src.includes("acquireOperationLease"));
  assert.ok(src.includes("assertOperationLeaseOwnership"));
  assert.ok(src.includes("releaseOperationLease"));
  assert.ok(src.includes("UNDO_RESULT_INGEST_LEASE_CONFLICT"));
});

test("admin recovery requires audited reason", () => {
  const controller = read("web/controllers/adminController.js");
  const service = read("web/services/bulkEdit/BulkEditRecoveryService.js");
  assert.ok(controller.includes("reason"));
  assert.ok(service.includes("RECOVERY_REASON_REQUIRED"));
  assert.ok(service.includes("bulkEditRecoveryAudit"));
});
