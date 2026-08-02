import { db } from "../repositories/repositoryDb.js";
import { refreshTargetSnapshotSetCounters } from "../repositories/targetSnapshotSetRepository.js";

export async function rebuildBulkEditAggregateCounters({
  shop,
  editHistoryId,
  snapshotSetId = null,
  dbClient = db,
}) {
  if (!shop || !editHistoryId) throw new Error("BULK_EDIT_COUNTER_SCOPE_REQUIRED");
  await dbClient.$executeRaw`
    WITH counts AS (
      SELECT COUNT(*)::integer AS total,
        COUNT(*) FILTER (WHERE upper("status") IN ('SUCCESS','SUCCEEDED','VERIFIED','FAILED','SKIPPED'))::integer AS processed
      FROM "ChangeRecord"
      WHERE "shop"=${shop} AND "editHistoryId"=${editHistoryId}
    )
    UPDATE "EditHistory" history
    SET "processedCount"=counts.processed,
        "totalItems"=GREATEST(history."totalItems", counts.total)
    FROM counts
    WHERE history."shop"=${shop} AND history."id"=${editHistoryId}
  `;
  if (snapshotSetId) {
    await refreshTargetSnapshotSetCounters({ shop, snapshotSetId, db: dbClient });
  }
}

export async function rebuildUndoAggregateCounters({ shop, undoOperationId, dbClient = db }) {
  if (!shop || !undoOperationId) throw new Error("UNDO_COUNTER_SCOPE_REQUIRED");
  await dbClient.$executeRaw`
    WITH counts AS (
      SELECT COUNT(*)::integer AS total,
        COUNT(*) FILTER (WHERE "outcome"::text IN ('RESTORED','FAILED','SKIPPED','CONFLICT','MANUAL_REVIEW'))::integer AS terminal,
        COUNT(*) FILTER (WHERE "outcome"::text='RESTORED')::integer AS restored,
        COUNT(*) FILTER (WHERE "outcome"::text IN ('FAILED','MANUAL_REVIEW'))::integer AS failed,
        COUNT(*) FILTER (WHERE "outcome"::text='SKIPPED')::integer AS skipped,
        COUNT(*) FILTER (WHERE "outcome"::text='CONFLICT')::integer AS conflicted
      FROM "UndoItem" WHERE "shop"=${shop} AND "undoOperationId"=${undoOperationId}
    )
    UPDATE "UndoOperation" operation SET
      "totalEligibleCount"=counts.total,
      "processedCount"=counts.terminal,
      "restoredCount"=counts.restored,
      "failedCount"=counts.failed,
      "skippedCount"=counts.skipped,
      "conflictedCount"=counts.conflicted
    FROM counts
    WHERE operation."shop"=${shop} AND operation."id"=${undoOperationId}
  `;
}
