import { db } from "../../repositories/repositoryDb.js";
import { addbulkUndoJob } from "../../Jobs/Queues/bulkUndoJob.js";
import { applyMirrorFromSuccessfulChangeRecords } from "../bulkEdit/BulkEditMirrorApplyService.js";
import {
  BULK_UNDO_STATES,
  buildExecutionError,
  normalizeUndoState,
} from "../bulkEditExecutionStateService.js";
import {
  acquireOperationLease,
  assertOperationLeaseOwnership,
  buildLeaseOwnerId,
  releaseOperationLease,
} from "../operationLeaseService.js";

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

function extractUndoResult(row = {}) {
  const errors = [row?.userErrors, row?.productSet?.userErrors, row?.product?.userErrors]
    .find((candidate) => Array.isArray(candidate)) || [];
  const productId = row?.productId
    || row?.product?.id
    || row?.productSet?.product?.id
    || row?.id
    || null;
  return { productId: productId ? String(productId) : null, errors };
}

function uniqueValues(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

async function persistUndoResultRows({
  shop,
  undoEditHistoryId,
  resultUrl,
  completedWithErrors,
  expectedSubmittedCount = 0,
}) {
  if (!resultUrl) {
    if (completedWithErrors) {
      throw new Error("UNDO_PARTIAL_RESULT_URL_REQUIRED");
    }
    if (Number(expectedSubmittedCount || 0) <= 0) {
      return { count: 0 };
    }
    const appliedAt = new Date();
    return db.changeRecord.updateMany({
      where: { shop, editHistoryId: undoEditHistoryId, status: "PENDING" },
      data: {
        status: "APPLIED",
        mirrorStatus: "MIRROR_PENDING",
        appliedAt,
        retryable: false,
      },
    });
  }
  const response = await fetch(resultUrl);
  if (!response.ok) throw new Error(`UNDO_RESULT_DOWNLOAD_FAILED:${response.status}`);
  const lines = (await response.text()).split(/\r?\n/).filter(Boolean);
  const appliedProductIds = [];
  const failedByMessage = new Map();
  for (const line of lines) {
    const item = extractUndoResult(JSON.parse(line));
    if (!item.productId) continue;
    const failed = item.errors.length > 0;
    if (!failed) {
      appliedProductIds.push(item.productId);
      continue;
    }
    const failureMessage = JSON.stringify(item.errors);
    const existing = failedByMessage.get(failureMessage) || [];
    existing.push(item.productId);
    failedByMessage.set(failureMessage, existing);
  }

  const writes = [];
  const appliedIds = uniqueValues(appliedProductIds);
  if (appliedIds.length) {
    writes.push(db.changeRecord.updateMany({
      where: {
        shop,
        editHistoryId: undoEditHistoryId,
        productId: { in: appliedIds },
        status: "PENDING",
      },
      data: {
        status: "APPLIED",
        mirrorStatus: "MIRROR_PENDING",
        appliedAt: new Date(),
        retryable: false,
        failureCode: null,
        failureMessage: null,
      },
    }));
  }

  for (const [failureMessage, productIds] of failedByMessage.entries()) {
    writes.push(db.changeRecord.updateMany({
      where: {
        shop,
        editHistoryId: undoEditHistoryId,
        productId: { in: uniqueValues(productIds) },
        status: "PENDING",
      },
      data: {
        status: "FAILED",
        mirrorStatus: "MIRROR_FAILED",
        failureCode: "SHOPIFY_USER_ERRORS",
        failureMessage,
        retryable: false,
      },
    }));
  }

  await db.$transaction(writes);
}

export class UndoResultIngestionService {
  async ingestUndoBulkOperationWebhook({
    shop,
    bulkOperationId,
    status,
    resultUrl = null,
  }) {
    const leaseOwnerId = buildLeaseOwnerId("bulk-undo-result-ingest");
    const lease = await acquireOperationLease({
      shop,
      namespace: "BULK_UNDO_RESULT_INGEST",
      resourceId: String(bulkOperationId),
      ownerId: leaseOwnerId,
    });
    if (!lease?.acquired) {
      throw new Error("UNDO_RESULT_INGEST_LEASE_CONFLICT");
    }
    try {
    await assertOperationLeaseOwnership({
      shop,
      namespace: "BULK_UNDO_RESULT_INGEST",
      resourceId: String(bulkOperationId),
      ownerId: leaseOwnerId,
    });
    const normalizedStatus = String(status || "").toUpperCase();
    const history = await db.editHistory.findFirst({
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
    const undoOperationId = String(undo?.undoOperationId || "").trim() || null;
    const undoEditHistoryId = String(undo?.undoEditHistoryId || "").trim() || null;
    const batch = history.batch && typeof history.batch === "object" ? history.batch : {};
    const allowedWebhookTerminalStates = [
      BULK_UNDO_STATES.AWAITING_SHOPIFY,
      BULK_UNDO_STATES.RECONCILE_SUBMITTED,
      BULK_UNDO_STATES.FINALIZING,
      BULK_UNDO_STATES.RETRYABLE_FAILURE,
    ];

    if (
      [BULK_UNDO_STATES.COMPLETED, BULK_UNDO_STATES.FAILED, BULK_UNDO_STATES.CANCELLED]
        .includes(String(undo.state || ""))
    ) {
      return { skipped: true, reason: "UNDO_ALREADY_TERMINAL", historyId: history.id };
    }
    if (
      undo.bulkOperationId
      && String(undo.bulkOperationId) !== String(bulkOperationId)
      && [
        BULK_UNDO_STATES.RECONCILE_SUBMITTED,
        BULK_UNDO_STATES.AWAITING_SHOPIFY,
        BULK_UNDO_STATES.FINALIZING,
      ].includes(String(undo.state || ""))
    ) {
      return { skipped: true, reason: "UNDO_BULK_OPERATION_STALE", historyId: history.id };
    }

    if (["FAILED", "CANCELED", "CANCELLED", "EXPIRED"].includes(normalizedStatus)) {
      await assertOperationLeaseOwnership({
        shop,
        namespace: "BULK_UNDO_RESULT_INGEST",
        resourceId: String(bulkOperationId),
        ownerId: leaseOwnerId,
      });
      const movedFailed = await db.editHistory.updateMany({
        where: {
          id: history.id,
          shop,
          OR: [
            ...allowedWebhookTerminalStates.map((state) => ({
              undo: { path: ["state"], equals: state },
            })),
          ],
          undo: {
            path: ["bulkOperationId"],
            equals: String(bulkOperationId),
          },
        },
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
      if (movedFailed.count !== 1) {
        throw new Error("UNDO_TERMINAL_FAILURE_TRANSITION_REJECTED");
      }
      if (undoOperationId) {
        await db.undoOperation.updateMany({
          where: { id: undoOperationId, shop },
          data: {
            status: "failed",
            state: "failed",
            bulkOperationId: null,
            processedCount: Number(undo.processedCount || 0),
          },
        });
      }
      if (undoEditHistoryId) {
        await db.$transaction([
          db.changeRecord.updateMany({
            where: { shop, editHistoryId: undoEditHistoryId, status: "PENDING" },
            data: {
              status: "FAILED",
              mirrorStatus: "MIRROR_FAILED",
              failureCode: `UNDO_BULK_${normalizedStatus}`,
              retryable: false,
            },
          }),
          db.editHistory.updateMany({
            where: { shop, id: undoEditHistoryId },
            data: {
              status: "failed",
              statusNormalized: "FAILED",
              executionState: "failed",
              executionStateNormalized: "FAILED",
              completedAt: new Date(),
            },
          }),
        ]);
      }
      return { success: true, failed: true, historyId: history.id };
    }
    if (!["COMPLETED", "COMPLETED_WITH_ERRORS"].includes(normalizedStatus)) {
      return {
        skipped: true,
        reason: "UNDO_BULK_OPERATION_NOT_TERMINAL",
        historyId: history.id,
        status: normalizedStatus || "UNKNOWN",
      };
    }

    const batchTargetCount = Number(batch.currentBatchTargetCount || 0);
    if (!undoEditHistoryId) {
      throw new Error("UNDO_EDIT_HISTORY_ID_REQUIRED");
    }
    await assertOperationLeaseOwnership({
      shop,
      namespace: "BULK_UNDO_RESULT_INGEST",
      resourceId: String(bulkOperationId),
      ownerId: leaseOwnerId,
    });
    await persistUndoResultRows({
      shop,
      undoEditHistoryId,
      resultUrl,
      completedWithErrors: normalizedStatus === "COMPLETED_WITH_ERRORS",
      expectedSubmittedCount: batchTargetCount,
    });
    const hasMore = Boolean(batch.hasMore);
    await applyMirrorFromSuccessfulChangeRecords({
      shop,
      historyId: undoEditHistoryId,
      finalStatus: hasMore
        ? null
        : normalizedStatus === "COMPLETED_WITH_ERRORS" ? "partial" : "completed",
      finalStatusNormalized: hasMore
        ? null
        : normalizedStatus === "COMPLETED_WITH_ERRORS" ? "PARTIAL" : "COMPLETED",
    });
    const nextProcessedCount = Number(undo.processedCount || 0) + batchTargetCount;

    if (hasMore) {
      await assertOperationLeaseOwnership({
        shop,
        namespace: "BULK_UNDO_RESULT_INGEST",
        resourceId: String(bulkOperationId),
        ownerId: leaseOwnerId,
      });
      const movedQueued = await db.editHistory.updateMany({
        where: {
          id: history.id,
          shop,
          OR: [
            ...allowedWebhookTerminalStates.map((state) => ({
              undo: { path: ["state"], equals: state },
            })),
          ],
          undo: {
            path: ["bulkOperationId"],
            equals: String(bulkOperationId),
          },
        },
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
      if (movedQueued.count !== 1) {
        throw new Error("UNDO_CONTINUATION_TRANSITION_REJECTED");
      }
      if (undoOperationId) {
        await db.undoOperation.updateMany({
          where: { id: undoOperationId, shop },
          data: {
            status: "pending",
            state: "queued",
            bulkOperationId: null,
            processedCount: nextProcessedCount,
          },
        });
      }

      await addbulkUndoJob({
        historyId: history.id,
        shop,
        source: "undo_webhook_continuation",
        executionId: undo.executionIdentity || history.executionIdentity || history.id,
      });

      return { success: true, continued: true, historyId: history.id };
    }

    const completedAt = new Date();
    await assertOperationLeaseOwnership({
      shop,
      namespace: "BULK_UNDO_RESULT_INGEST",
      resourceId: String(bulkOperationId),
      ownerId: leaseOwnerId,
    });
    const completionResult = await db.$transaction(async (tx) => {
      const movedCompleted = await tx.editHistory.updateMany({
        where: {
          id: history.id,
          shop,
          OR: [
            ...allowedWebhookTerminalStates.map((state) => ({
              undo: { path: ["state"], equals: state },
            })),
          ],
          undo: {
            path: ["bulkOperationId"],
            equals: String(bulkOperationId),
          },
        },
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
      if (movedCompleted.count !== 1) {
        const existing = await tx.editHistory.findFirst({
          where: { id: history.id, shop },
          select: { undo: true },
        });
        const existingUndo = normalizeUndoState(existing?.undo, {});
        if (String(existingUndo.state || "") !== BULK_UNDO_STATES.COMPLETED) {
          throw new Error("UNDO_COMPLETION_TRANSITION_REJECTED");
        }
      }
      if (undoOperationId) {
        await tx.undoOperation.updateMany({
          where: { id: undoOperationId, shop },
          data: {
            status: "completed",
            state: "completed",
            bulkOperationId: null,
            processedCount: nextProcessedCount,
          },
        });
      }
      return movedCompleted;
    });
    if (completionResult.count !== 1) {
      return {
        success: true,
        continued: false,
        reconciled: true,
        reason: "undo_already_completed",
        historyId: history.id,
      };
    }

    return { success: true, continued: false, historyId: history.id };
    } finally {
      await releaseOperationLease({
        shop,
        namespace: "BULK_UNDO_RESULT_INGEST",
        resourceId: String(bulkOperationId),
        ownerId: leaseOwnerId,
      }).catch(() => {});
    }
  }
}
