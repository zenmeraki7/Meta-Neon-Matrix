-- Both indexes exactly duplicate an existing unique B-tree index.
-- These index removals are transaction-safe for Prisma shadow-database replay.
DROP INDEX IF EXISTS
  "UndoOperationConflictChunk_shop_undoOperationId_chunkType_c_idx";

DROP INDEX IF EXISTS
  "AutomaticProductRule_shop_id_idx";
