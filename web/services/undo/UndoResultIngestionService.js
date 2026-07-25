import { db } from "../../repositories/repositoryDb.js";
import { addbulkUndoJob } from "../../Jobs/Queues/bulkUndoJob.js";
import UndoEditService from "../productService/productBulkUndoService.js";
import { getSession } from "../../utils/sessionHandler.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
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
import { refreshTargetSnapshotSetCounters } from "../../repositories/targetSnapshotSetRepository.js";

function mergeBatch(existingBatch, patch) {
  return {
    ...(existingBatch && typeof existingBatch === "object"
      ? existingBatch
      : {}),
    ...patch,
  };
}

function calculateDurationMs(startedAt, completedAt = new Date()) {
  const start = new Date(startedAt || completedAt).getTime();
  const end = new Date(completedAt).getTime();
  return Math.max(end - start, 0);
}

function extractBulkRowErrors(row = {}) {
  const payload = row?.data && typeof row.data === "object" ? row.data : row;
  const errors =
    payload?.productSet?.userErrors ||
    payload?.productSet?.productSetOperation?.userErrors ||
    payload?.userErrors ||
    row?.userErrors ||
    [];
  return Array.isArray(errors) ? errors : [];
}

async function inspectUndoResultJsonl(resultUrl) {
  if (!resultUrl) throw new Error("UNDO_RESULT_URL_MISSING");
  const response = await fetch(resultUrl);
  if (!response.ok) {
    throw new Error(`UNDO_RESULT_DOWNLOAD_FAILED_${response.status}`);
  }
  const body = await response.text();
  let rowCount = 0;
  let malformedCount = 0;
  const itemErrors = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rowCount += 1;
    try {
      const parsed = JSON.parse(trimmed);
      for (const error of extractBulkRowErrors(parsed)) {
        if (itemErrors.length < 200) itemErrors.push(error);
      }
    } catch {
      malformedCount += 1;
    }
  }
  return {
    rowCount,
    malformedCount,
    failureCount: itemErrors.length + malformedCount,
    itemErrors,
  };
}

async function resolveUndoResultUrl({ session, shopifyBulkOperationId, resultUrl }) {
  if (resultUrl) return resultUrl;
  const client = new UndoEditService(session).client;
  const response = await client.request(
    `#graphql
      query UndoBulkResultUrl($id: ID!) {
        node(id: $id) {
          ... on BulkOperation { id status url partialDataUrl }
        }
      }
    `,
    { variables: { id: String(shopifyBulkOperationId) } }
  );
  const operation = response?.data?.node || response?.body?.data?.node || null;
  return operation?.url || operation?.partialDataUrl || null;
}

async function loadTrustedUndoReplay({ history, undo, shop }) {
  const chunks = undo?.undoOperationId
    ? await db.undoOperationConflictChunk.findMany({
        where: {
          shop,
          undoOperationId: undo.undoOperationId,
          chunkType: "SAFE_IDENTITIES",
        },
        orderBy: { chunkIndex: "asc" },
        select: { payload: true },
      })
    : [];
  const targetIdentities = chunks.flatMap((chunk) =>
    Array.isArray(chunk?.payload?.targetIdentities)
      ? chunk.payload.targetIdentities.map(String)
      : []
  );
  if (!targetIdentities.length) throw new Error("UNDO_SAFE_TARGETS_MISSING");

  const changes = await db.changeRecord.findMany({
    where: {
      shop,
      editHistoryId: history.id,
      targetIdentity: { in: targetIdentities },
    },
  });
  const snapshotSetId = String(
    history?.batch?.targetSnapshotRef?.snapshotSetId || ""
  ).trim();
  if (!snapshotSetId) throw new Error("UNDO_SNAPSHOT_SET_MISSING");
  const snapshots = await db.targetSnapshotItem.findMany({
    where: { shop, snapshotSetId, targetKey: { in: targetIdentities } },
    select: {
      id: true,
      targetKey: true,
      beforeValues: true,
      plannedMutation: true,
    },
  });
  const snapshotByIdentity = new Map(
    snapshots.map((snapshot) => [String(snapshot.targetKey), snapshot])
  );
  return { changes, snapshots, snapshotByIdentity, snapshotSetId };
}

async function applyVerifiedUndoToMirror({ shop, replayProducts }) {
  const store = await db.store.findUnique({
    where: { shopUrl: shop },
    select: { currentProductMirrorBatchId: true },
  });
  const mirrorBatchId = store?.currentProductMirrorBatchId;
  if (!mirrorBatchId) throw new Error("UNDO_ACTIVE_MIRROR_BATCH_MISSING");

  const variantFields = new Set([
    "title",
    "sku",
    "barcode",
    "price",
    "compareAtPrice",
    "inventoryQuantity",
    "inventoryPolicy",
    "taxable",
    "taxCode",
    "weight",
    "weightUnit",
  ]);
  const productFields = new Set([
    "title",
    "handle",
    "vendor",
    "productType",
    "status",
    "tags",
    "templateSuffix",
    "descriptionHtml",
  ]);

  for (const replay of replayProducts) {
    const productData = {};
    for (const change of replay.productFieldChanges || []) {
      const field =
        change?.field === "description" ? "descriptionHtml" : change?.field;
      if (productFields.has(field)) {
        productData[field] = change.revertValue ?? change.oldValue;
      }
    }
    if (Object.keys(productData).length) {
      await db.product.updateMany({
        where: { shop, id: replay.productId, mirrorBatchId },
        data: productData,
      });
    }
    for (const variant of replay.variantFieldChanges || []) {
      const variantData = {};
      for (const change of variant.changes || []) {
        const field =
          change?.field === "inventory" ? "inventoryQuantity" : change?.field;
        if (variantFields.has(field)) {
          variantData[field] = change.revertValue ?? change.oldValue;
        }
      }
      if (Object.keys(variantData).length) {
        await db.variant.updateMany({
          where: { shop, id: variant.variantId, mirrorBatchId },
          data: variantData,
        });
      }
    }
  }
}

async function markUndoExecutionFailed({
  history,
  undo,
  shop,
  code,
  message,
  details = {},
}) {
  const completedAt = new Date();
  const moved = await db.editHistory.updateMany({
    where: { id: history.id, shop, updatedAt: history.updatedAt },
    data: {
      shopifyBulkOperationId: null,
      processingChunkId: null,
      undo: {
        ...undo,
        outcomeStatus: "failed",
        executionState: BULK_UNDO_STATES.FAILED,
        completedAt,
        shopifyBulkOperationId: null,
        durationMs: calculateDurationMs(
          undo.startedAt || history.startedAt,
          completedAt
        ),
        error: buildExecutionError({
          code,
          stage: "webhook_ingest",
          message,
          retryable: false,
          details,
        }),
      },
    },
  });
  if (moved.count !== 1) {
    throw new Error("UNDO_TERMINAL_FAILURE_TRANSITION_REJECTED");
  }
  if (undo?.undoOperationId) {
    await db.undoOperation.updateMany({
      where: { id: undo.undoOperationId, shop },
      data: {
        outcomeStatus: "failed",
        executionState: "failed",
        shopifyBulkOperationId: null,
        processedCount: Number(undo.processedCount || 0),
        failureCode: String(code || "UNDO_FAILED").toUpperCase(),
        failureMessage: message,
        completedAt,
      },
    });
  }
}

export class UndoResultIngestionService {
  async ingestUndoBulkOperationWebhook({
    shop,
    shopifyBulkOperationId,
    status,
    resultUrl = null,
  }) {
    const leaseOwnerId = buildLeaseOwnerId("bulk-undo-result-ingest");
    const lease = await acquireOperationLease({
      shop,
      namespace: "BULK_UNDO_RESULT_INGEST",
      resourceId: String(shopifyBulkOperationId),
      ownerId: leaseOwnerId,
    });
    if (!lease?.acquired) {
      throw new Error("UNDO_RESULT_INGEST_LEASE_CONFLICT");
    }
    try {
      await assertOperationLeaseOwnership({
        shop,
        namespace: "BULK_UNDO_RESULT_INGEST",
        resourceId: String(shopifyBulkOperationId),
        ownerId: leaseOwnerId,
      });
      const normalizedStatus = String(status || "").toUpperCase();
      const history = await db.editHistory.findFirst({
        where: {
          shop,
          shopifyBulkOperationId: String(shopifyBulkOperationId),
        },
        select: {
          id: true,
          shop: true,
          batch: true,
          undo: true,
          startedAt: true,
          executionIdentity: true,
          updatedAt: true,
        },
      });

      if (!history) {
        return { skipped: true, reason: "UNDO_HISTORY_NOT_FOUND" };
      }

      const undo = normalizeUndoState(history.undo, {});
      const undoOperationId =
        String(undo?.undoOperationId || "").trim() || null;
      const batch =
        history.batch && typeof history.batch === "object" ? history.batch : {};
      const allowedWebhookTerminalStates = [
        BULK_UNDO_STATES.AWAITING_SHOPIFY,
        BULK_UNDO_STATES.FINALIZING,
        BULK_UNDO_STATES.RETRYABLE_FAILURE,
      ];

      if (
        !allowedWebhookTerminalStates.includes(String(undo.executionState || "")) ||
        String(undo.shopifyBulkOperationId || "") !== String(shopifyBulkOperationId)
      ) {
        return {
          skipped: true,
          reason: "UNDO_BULK_OPERATION_STALE",
          historyId: history.id,
        };
      }

      if (
        ["FAILED", "CANCELED", "CANCELLED", "EXPIRED"].includes(
          normalizedStatus
        )
      ) {
        await assertOperationLeaseOwnership({
          shop,
          namespace: "BULK_UNDO_RESULT_INGEST",
          resourceId: String(shopifyBulkOperationId),
          ownerId: leaseOwnerId,
        });
        const movedFailed = await db.editHistory.updateMany({
          where: {
            id: history.id,
            shop,
            updatedAt: history.updatedAt,
          },
          data: {
            shopifyBulkOperationId: null,
            processingChunkId: null,
            undo: {
              ...undo,
              outcomeStatus: "failed",
              executionState: BULK_UNDO_STATES.FAILED,
              completedAt: new Date(),
              shopifyBulkOperationId: null,
              durationMs: calculateDurationMs(
                undo.startedAt || history.startedAt,
                new Date()
              ),
              error: buildExecutionError({
                code: "undo_bulk_failure",
                stage: "webhook_ingest",
                message: `Undo bulk operation ${normalizedStatus}`,
                retryable: false,
                details: { shopifyBulkOperationId },
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
              outcomeStatus: "failed",
              executionState: "failed",
              shopifyBulkOperationId: null,
              processedCount: Number(undo.processedCount || 0),
              failedCount: Math.max(
                Number(undo?.eligibility?.eligibleCount || 0) -
                  Number(undo.processedCount || 0),
                1
              ),
              failureCode: "UNDO_SHOPIFY_BULK_OPERATION_FAILED",
              failureMessage: `Shopify undo operation ${normalizedStatus}`,
              completedAt: new Date(),
            },
          });
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

      const session = await getSession(shop);
      if (!session?.shop || session.shop !== shop) {
        throw new Error("UNDO_RESULT_SESSION_NOT_AVAILABLE");
      }
      const authoritativeResultUrl = await resolveUndoResultUrl({
        session,
        shopifyBulkOperationId,
        resultUrl,
      });
      const trustedReplay = await loadTrustedUndoReplay({
        history,
        undo,
        shop,
      });
      const resultSummary = await inspectUndoResultJsonl(
        authoritativeResultUrl
      );
      if (resultSummary.failureCount > 0) {
        await assertOperationLeaseOwnership({
          shop,
          namespace: "BULK_UNDO_RESULT_INGEST",
          resourceId: String(shopifyBulkOperationId),
          ownerId: leaseOwnerId,
        });
        await db.$transaction(async (tx) => {
          await tx.targetSnapshotItem.updateMany({
            where: {
              shop,
              id: { in: trustedReplay.snapshots.map((snapshot) => snapshot.id) },
              undoStatus: { in: ["PENDING", "SUBMITTED"] },
            },
            data: {
              undoStatus: "FAILED",
              undoErrorCode: "SHOPIFY_UNDO_ITEM_FAILURE",
              undoErrorMessage: "Shopify rejected the undo mutation row",
              undoMutation: {
                version: 1,
                status: "failed",
                verified: false,
                itemErrors: resultSummary.itemErrors,
              },
            },
          });
          await refreshTargetSnapshotSetCounters({
            shop,
            snapshotSetId: trustedReplay.snapshotSetId,
            db: tx,
          });
        });
        await markUndoExecutionFailed({
          history,
          undo,
          shop,
          code: "undo_shopify_item_failure",
          message: "Shopify rejected one or more undo mutation rows",
          details: {
            shopifyBulkOperationId,
            rowCount: resultSummary.rowCount,
            malformedCount: resultSummary.malformedCount,
            itemErrors: resultSummary.itemErrors,
          },
        });
        return {
          success: false,
          failed: true,
          reason: "UNDO_SHOPIFY_ITEM_FAILURE",
          historyId: history.id,
        };
      }

      const undoService = new UndoEditService(session);
      const replayProducts = undoService.buildUndoReplayRecords(
        trustedReplay.changes,
        trustedReplay.snapshotByIdentity
      );
      const verification = await undoService.verifyUndoRestored(replayProducts);
      if (!verification.verified) {
        await assertOperationLeaseOwnership({
          shop,
          namespace: "BULK_UNDO_RESULT_INGEST",
          resourceId: String(shopifyBulkOperationId),
          ownerId: leaseOwnerId,
        });
        await db.$transaction(async (tx) => {
          for (const snapshot of trustedReplay.snapshots) {
            await tx.targetSnapshotItem.updateMany({
              where: {
                id: snapshot.id,
                shop,
                undoStatus: { in: ["PENDING", "SUBMITTED"] },
              },
              data: {
                undoStatus: "FAILED",
                undoErrorCode: "UNDO_VERIFICATION_FAILED",
                undoErrorMessage:
                  "Shopify state did not match the trusted undo snapshot",
                undoMutation: {
                  version: 1,
                  status: "verification_failed",
                  verified: false,
                  verifiedAt: verification.verifiedAt,
                  fields: verification.evidence.filter(
                    (entry) => entry.targetIdentity === snapshot.targetKey
                  ),
                },
              },
            });
          }
          await refreshTargetSnapshotSetCounters({
            shop,
            snapshotSetId: trustedReplay.snapshotSetId,
            db: tx,
          });
        });
        await markUndoExecutionFailed({
          history,
          undo,
          shop,
          code: "undo_verification_failed",
          message: "Shopify state did not match the trusted undo snapshot",
          details: {
            shopifyBulkOperationId,
            failures: verification.failures.slice(0, 200),
          },
        });
        return {
          success: false,
          failed: true,
          reason: "UNDO_VERIFICATION_FAILED",
          historyId: history.id,
        };
      }

      await applyVerifiedUndoToMirror({ shop, replayProducts });
      await db.$transaction(async (tx) => {
        for (const snapshot of trustedReplay.snapshots) {
          await tx.targetSnapshotItem.updateMany({
            where: {
              id: snapshot.id,
              shop,
              undoStatus: { in: ["PENDING", "SUBMITTED"] },
            },
            data: {
              undoStatus: "SUCCEEDED",
              undoErrorCode: null,
              undoErrorMessage: null,
              undoneAt: new Date(verification.verifiedAt),
              undoMutation: {
                version: 1,
                status: "succeeded",
                verified: true,
                verifiedAt: verification.verifiedAt,
                fields: verification.evidence.filter(
                  (entry) => entry.targetIdentity === snapshot.targetKey
                ),
              },
            },
          });
        }
        await refreshTargetSnapshotSetCounters({
          shop,
          snapshotSetId: trustedReplay.snapshotSetId,
          db: tx,
        });
      });

      const batchTargetCount = Number(batch.currentBatchTargetCount || 0);
      const nextProcessedCount =
        Number(undo.processedCount || 0) + batchTargetCount;
      const hasMore = Boolean(batch.hasMore);

      if (hasMore) {
        await assertOperationLeaseOwnership({
          shop,
          namespace: "BULK_UNDO_RESULT_INGEST",
          resourceId: String(shopifyBulkOperationId),
          ownerId: leaseOwnerId,
        });
        const movedQueued = await db.editHistory.updateMany({
          where: {
            id: history.id,
            shop,
            updatedAt: history.updatedAt,
          },
          data: {
            shopifyBulkOperationId: null,
            processingChunkId: null,
            batch: mergeBatch(batch, {
              currentBatchId: null,
              currentBatchCount: 0,
              currentBatchTargetCount: 0,
              lastUndoFinalizedAt: new Date().toISOString(),
            }),
            undo: {
              ...undo,
              processedCount: nextProcessedCount,
              executionState: BULK_UNDO_STATES.QUEUED,
              outcomeStatus: "pending",
              shopifyBulkOperationId: null,
              durationMs: calculateDurationMs(
                undo.startedAt || history.startedAt
              ),
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
              outcomeStatus: "pending",
              executionState: "queued",
              shopifyBulkOperationId: null,
              processedCount: nextProcessedCount,
            },
          });
        }

        await addbulkUndoJob({
          historyId: history.id,
          shop,
          source: "undo_webhook_continuation",
          executionId:
            undo.executionIdentity || history.executionIdentity || history.id,
        });

        return { success: true, continued: true, historyId: history.id };
      }

      const completedAt = new Date();
      const conflictedCount = Number(undo?.conflictReport?.conflictCount || 0);
      const completedWithErrors = normalizedStatus === "COMPLETED_WITH_ERRORS";
      const isPartial = conflictedCount > 0 || completedWithErrors;
      await assertOperationLeaseOwnership({
        shop,
        namespace: "BULK_UNDO_RESULT_INGEST",
        resourceId: String(shopifyBulkOperationId),
        ownerId: leaseOwnerId,
      });
      const movedCompleted = await db.editHistory.updateMany({
        where: {
          id: history.id,
          shop,
          updatedAt: history.updatedAt,
        },
        data: {
          shopifyBulkOperationId: null,
          processingChunkId: null,
          batch: mergeBatch(batch, {
            hasMore: false,
            currentBatchId: null,
            currentBatchCount: 0,
            currentBatchTargetCount: 0,
            lastUndoFinalizedAt: completedAt.toISOString(),
          }),
          undo: {
            ...undo,
            outcomeStatus: isPartial ? "partial" : "completed",
            executionState: isPartial
              ? BULK_UNDO_STATES.PARTIAL
              : BULK_UNDO_STATES.COMPLETED,
            allowed: false,
            completedAt,
            processedCount: nextProcessedCount,
            durationMs: calculateDurationMs(
              undo.startedAt || history.startedAt,
              completedAt
            ),
            error: null,
            verification: {
              status: "verified",
              verified: true,
              verifiedAt: verification.verifiedAt,
              evidenceCount: verification.evidence.length,
            },
            shopifyBulkOperationId: null,
            lastChangeRecordId: null,
          },
        },
      });
      if (movedCompleted.count !== 1) {
        throw new Error("UNDO_COMPLETION_TRANSITION_REJECTED");
      }
      if (undoOperationId) {
        await db.undoOperation.updateMany({
          where: { id: undoOperationId, shop },
          data: {
            outcomeStatus: isPartial ? "partial" : "completed",
            executionState: isPartial ? "partially_completed" : "completed",
            shopifyBulkOperationId: null,
            processedCount: nextProcessedCount,
            restoredCount: nextProcessedCount,
            conflictedCount,
            failedCount: completedWithErrors ? 1 : 0,
            failureCode: null,
            failureMessage: null,
            completedAt,
          },
        });
      }

      await clearKeyCaches(`${shop}:fetchHistories`).catch(() => {});
      await clearKeyCaches(`${shop}:historyDetails:${history.id}`).catch(
        () => {}
      );
      await clearKeyCaches(`${shop}:historyChanges:${history.id}`).catch(
        () => {}
      );

      return { success: true, continued: false, historyId: history.id };
    } finally {
      await releaseOperationLease({
        shop,
        namespace: "BULK_UNDO_RESULT_INGEST",
        resourceId: String(shopifyBulkOperationId),
        ownerId: leaseOwnerId,
      }).catch(() => {});
    }
  }
}
