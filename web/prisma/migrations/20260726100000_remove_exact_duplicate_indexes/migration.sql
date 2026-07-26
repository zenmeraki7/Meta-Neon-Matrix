-- Both indexes exactly duplicate an existing unique B-tree index.
-- CONCURRENTLY avoids blocking normal Neon reads and writes while dropping them.
DROP INDEX CONCURRENTLY IF EXISTS
  "UndoOperationConflictChunk_shop_undoOperationId_chunkType_c_idx";

DROP INDEX CONCURRENTLY IF EXISTS
  "AutomaticProductRule_shop_id_idx";
