import { prisma } from "../../config/database.js";
import { addbulkUndoJob } from "../../Jobs/Queues/bulkUndoJob.js";
import {
  BULK_UNDO_STATES,
  buildExecutionError,
  normalizeUndoState,
} from "../bulkEditExecutionStateService.js";

function mergeBatch(existingBatch, patch) {
  return {
    ...(existingBatch && typeof existingBatch === "object" ? existingBatch : {}),
    ...patch,
  };
}

function calculateDurationMs(startedAt, completedAt = new Date()) {
  const start = new Date(startedAt || completedAt).getTime();
  const end = new Date(completedAt).getTime();
  return Math.max(end - start, 0);
}

export class UndoResultIngestionService {
  async ingestUndoBulkOperationWebhook({
    shop,
    bulkOperationId,
    status,
  }) {
    const normalizedStatus = String(status || "").toUpperCase();
    const history = await prisma.editHistory.findFirst({
      where: {
        shop,
        OR: [
          { bulkOperationId: String(bulkOperationId) },
          {
            undo: {
              path: ["bulkOperationId"],
              equals: String(bulkOperationId),
            },
          },
        ],
      },
      select: {
        id: true,
        shop: true,
        batch: true,
        undo: true,
        startedAt: true,
        executionIdentity: true,
      },
    });

    if (!history) {
      return { skipped: true, reason: "UNDO_HISTORY_NOT_FOUND" };
    }

    const undo = normalizeUndoState(history.undo, {});
    const batch = history.batch && typeof history.batch === "object" ? history.batch : {};

    if (
      [BULK_UNDO_STATES.COMPLETED, BULK_UNDO_STATES.FAILED, BULK_UNDO_STATES.CANCELLED]
        .includes(String(undo.state || ""))
    ) {
      return { skipped: true, reason: "UNDO_ALREADY_TERMINAL", historyId: history.id };
    }

    if (["FAILED", "CANCELED", "CANCELLED", "EXPIRED"].includes(normalizedStatus)) {
      await prisma.editHistory.updateMany({
        where: { id: history.id, shop },
        data: {
          bulkOperationId: null,
          processingBatchId: null,
          undo: {
            ...undo,
            status: "failed",
            state: BULK_UNDO_STATES.FAILED,
            completedAt: new Date(),
            bulkOperationId: null,
            durationMs: calculateDurationMs(undo.startedAt || history.startedAt, new Date()),
            error: buildExecutionError({
              code: "undo_bulk_failure",
              stage: "webhook_ingest",
              message: `Undo bulk operation ${normalizedStatus}`,
              retryable: false,
              details: { bulkOperationId },
            }),
          },
        },
      });
      return { success: true, failed: true, historyId: history.id };
    }

    const batchTargetCount = Number(batch.currentBatchTargetCount || 0);
    const nextProcessedCount = Number(undo.processedCount || 0) + batchTargetCount;
    const hasMore = Boolean(batch.hasMore);

    if (hasMore) {
      await prisma.editHistory.updateMany({
        where: { id: history.id, shop },
        data: {
          bulkOperationId: null,
          processingBatchId: null,
          batch: mergeBatch(batch, {
            currentBatchId: null,
            currentBatchCount: 0,
            currentBatchTargetCount: 0,
            lastUndoFinalizedAt: new Date().toISOString(),
          }),
          undo: {
            ...undo,
            processedCount: nextProcessedCount,
            state: BULK_UNDO_STATES.QUEUED,
            status: "pending",
            bulkOperationId: null,
            durationMs: calculateDurationMs(undo.startedAt || history.startedAt),
          },
        },
      });

      await addbulkUndoJob({
        historyId: history.id,
        shop,
        source: "undo_webhook_continuation",
        executionId: undo.executionIdentity || history.executionIdentity || history.id,
      });

      return { success: true, continued: true, historyId: history.id };
    }

    const completedAt = new Date();
    await prisma.editHistory.updateMany({
      where: { id: history.id, shop },
      data: {
        bulkOperationId: null,
        processingBatchId: null,
        batch: mergeBatch(batch, {
          lastProductId: null,
          hasMore: false,
          currentBatchId: null,
          currentBatchCount: 0,
          currentBatchTargetCount: 0,
          lastUndoFinalizedAt: completedAt.toISOString(),
        }),
        undo: {
          ...undo,
          status: "completed",
          state: BULK_UNDO_STATES.COMPLETED,
          allowed: false,
          completedAt,
          processedCount: nextProcessedCount,
          durationMs: calculateDurationMs(undo.startedAt || history.startedAt, completedAt),
          bulkOperationId: null,
        },
      },
    });

    return { success: true, continued: false, historyId: history.id };
  }
}

