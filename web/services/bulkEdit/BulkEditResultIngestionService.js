import readline from "node:readline";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import crypto from "crypto";
import { db } from "../../repositories/repositoryDb.js";
import logger from "../../utils/loggerUtils.js";
import {
  normalizeEditHistoryStatus,
} from "../../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../operationLifecycleStateMachine.js";
import {
  acquireOperationLease,
  buildLeaseOwnerId,
  heartbeatOperationLease,
  releaseOperationLease,
} from "../operationLeaseService.js";
import { guardedEditHistoryUpdate } from "../operationTransitionGuards.js";
import { transitionOperation } from "../operationTransitionService.js";
import { applyMirrorFromSuccessfulChangeRecords } from "./BulkEditMirrorApplyService.js";
import { schedulePostMutationMirrorReconciliation } from "../mirrorReconciliationService.js";

const require = createRequire(import.meta.url);
const prismaGenerated = require("../../generated/prisma/index.js");
const { Prisma } = prismaGenerated;
const HEARTBEAT_FAILURE_LIMIT = 2;

function normalizeTargetIdentity(row) {
  return String(
    row?.targetIdentity
      || row?.target?.identity
      || "",
  ).trim() || null;
}

function extractRowResult(row = {}) {
  const userErrors =
    [row?.userErrors, row?.productSet?.userErrors, row?.product?.userErrors]
      .find((candidate) => Array.isArray(candidate))
    || [];
  const normalizedErrors = Array.isArray(userErrors) ? userErrors : [];

  const targetIdentity = normalizeTargetIdentity(row);
  const productIdRaw = row?.productId || row?.id || row?.product?.id || null;
  const variantIdRaw = row?.variantId || row?.variant?.id || null;

  return {
    targetIdentity,
    productId: productIdRaw ? String(productIdRaw) : null,
    variantId: variantIdRaw ? String(variantIdRaw) : null,
    status: normalizedErrors.length > 0 ? "FAILED" : "SUCCESS",
    shopifyUserErrors: normalizedErrors,
  };
}

async function processJsonlLines(url, onRow, options = {}) {
  const headers = options?.headers || undefined;
  const response = await fetch(url, headers ? { headers } : undefined);
  if (!response.ok) {
    throw new Error(`Failed to download Shopify result JSONL: ${response.status}`);
  }
  if (options?.requirePartialResponse && response.status !== 206) {
    return {
      rangeAccepted: false,
      byteOffset: Number(options?.startingByteOffset || 0),
    };
  }
  const body = response.body;
  if (!body) {
    throw new Error("Shopify result body is empty");
  }

  const nodeStream = Readable.fromWeb(body);
  const rl = readline.createInterface({ input: nodeStream, crlfDelay: Infinity });
  let byteOffset = Number(options?.startingByteOffset || 0);
  for await (const line of rl) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    byteOffset += Buffer.byteLength(`${line}\n`, "utf8");
    // eslint-disable-next-line no-await-in-loop
    await onRow(trimmed, byteOffset);
  }

  return {
    rangeAccepted: response.status === 206,
    byteOffset,
  };
}

async function processJsonlLinesFromCheckpoint(url, checkpoint, onRow) {
  let currentRow = 0;
  const byteOffset = Number(checkpoint?.byteOffset || 0);
  if (byteOffset > 0) {
    const rangeResult = await processJsonlLines(
      url,
      async (line, nextByteOffset) => {
        currentRow += 1;
        await onRow(line, Number(checkpoint?.rowOffset || 0) + currentRow, nextByteOffset);
      },
      {
        headers: { Range: `bytes=${byteOffset}-` },
        startingByteOffset: byteOffset,
        requirePartialResponse: true,
      },
    );
    if (rangeResult.rangeAccepted) return;
    currentRow = 0;
  }

  await processJsonlLines(url, async (line, nextByteOffset) => {
    currentRow += 1;
    if (currentRow <= Number(checkpoint?.rowOffset || 0)) return;
    await onRow(line, currentRow, nextByteOffset);
  });
}

function mergeBatch(existingBatch, patch) {
  return {
    ...(existingBatch && typeof existingBatch === "object" ? existingBatch : {}),
    ...patch,
  };
}

function checkpointChecksum(prevChecksum, entry) {
  return crypto
    .createHash("sha256")
    .update(`${String(prevChecksum || "")}|${String(entry || "")}`)
    .digest("hex");
}

function getCheckpointMetadata(checkpointRecord) {
  return checkpointRecord?.metadata
    && typeof checkpointRecord.metadata === "object"
    && !Array.isArray(checkpointRecord.metadata)
    ? checkpointRecord.metadata
    : {};
}

function appendIngestionChunk(metadata, chunk) {
  const existing = Array.isArray(metadata?.chunks) ? metadata.chunks : [];
  return [...existing.slice(-199), chunk];
}

function buildIngestionRunId({ existingCheckpoint, historyId, batchId, attempt }) {
  if (existingCheckpoint?.ingestionRunId) return String(existingCheckpoint.ingestionRunId);
  return `${historyId}:${batchId || "none"}:${attempt}:${crypto.randomUUID()}`;
}

function groupPendingUpdates(updates = []) {
  const groups = new Map();
  for (const item of updates) {
    const errors = Array.isArray(item.shopifyUserErrors) ? item.shopifyUserErrors : [];
    const key = JSON.stringify({
      status: item.status,
      errors,
    });
    const group = groups.get(key) || {
      status: item.status,
      shopifyUserErrors: errors,
      targetIdentities: [],
    };
    group.targetIdentities.push(item.targetIdentity);
    groups.set(key, group);
  }
  return [...groups.values()];
}

async function mergeChangeRecordIngestionOptions({
  shop,
  historyId,
  batchId,
  group,
  attempt,
}) {
  const targetIdentities = [...new Set(group.targetIdentities.filter(Boolean))];
  if (!targetIdentities.length) return { count: 0 };

  const status = group.status;
  const failureCode = status === "FAILED" ? "SHOPIFY_USER_ERRORS" : null;
  const failureMessage = status === "FAILED"
    ? JSON.stringify(group.shopifyUserErrors || [])
    : null;
  const ingestionOptions = {
    resultIngestion: {
      attempt,
      shopifyUserErrors: group.shopifyUserErrors || [],
    },
  };

  const rows = await db.$executeRaw`
    UPDATE "ChangeRecord"
       SET "status" = ${status},
           "failureCode" = ${failureCode},
           "failureMessage" = ${failureMessage},
           "options" = COALESCE("options", '{}'::jsonb) || ${JSON.stringify(ingestionOptions)}::jsonb
     WHERE "shop" = ${shop}
       AND "editHistoryId" = ${historyId}
       ${batchId ? Prisma.sql`AND "batchId" = ${batchId}` : Prisma.empty}
       AND "targetIdentity" IN (${Prisma.join(targetIdentities)})
       AND "status" IN ('pending', 'PENDING', 'failed', 'FAILED')
  `;
  return { count: Number(rows || 0) };
}

export class BulkEditResultIngestionService {
  async ingestCompletedBulkOperation({
    shop,
    historyId,
    executionId = null,
    bulkOperationId,
    resultUrl,
    attempt = 1,
  }) {
    if (!shop || !historyId) {
      throw new Error("RESULT_INGEST_REQUIRES_SHOP_AND_HISTORY_ID");
    }
    if (!bulkOperationId || !resultUrl) {
      throw new Error("RESULT_INGEST_REQUIRES_BULK_OPERATION_AND_RESULT_URL");
    }

    const leaseOwnerId = buildLeaseOwnerId("bulk-edit-result-ingest");
    const lease = await acquireOperationLease({
      shop,
      namespace: "BULK_EDIT_RESULT_INGEST",
      resourceId: String(historyId),
      ownerId: leaseOwnerId,
    });
    if (!lease?.acquired) {
      throw new Error("RESULT_INGEST_LEASE_CONFLICT");
    }
    let heartbeatFailures = 0;
    let leaseHeartbeatLost = false;
    const leaseHeartbeat = setInterval(() => {
      heartbeatOperationLease({
        shop,
        namespace: "BULK_EDIT_RESULT_INGEST",
        resourceId: String(historyId),
        ownerId: leaseOwnerId,
      }).then((ok) => {
        if (ok) {
          heartbeatFailures = 0;
          return;
        }
        heartbeatFailures += 1;
        logger.warn("Bulk edit result ingest heartbeat failed", {
          shop,
          historyId,
          heartbeatFailures,
        });
        if (heartbeatFailures >= HEARTBEAT_FAILURE_LIMIT) {
          leaseHeartbeatLost = true;
        }
      }).catch((error) => {
        heartbeatFailures += 1;
        logger.error("Bulk edit result ingest heartbeat error", {
          shop,
          historyId,
          heartbeatFailures,
          message: error?.message || String(error),
        });
        if (heartbeatFailures >= HEARTBEAT_FAILURE_LIMIT) {
          leaseHeartbeatLost = true;
        }
      });
    }, 30_000);
    try {
    const history = await db.editHistory.findFirst({
      where: { id: historyId, shop },
      select: {
        id: true,
        shop: true,
        executionIdentity: true,
        batch: true,
        bulkOperationId: true,
        processingBatchId: true,
      },
    });

    if (!history) throw new Error("Edit history not found");
    if (executionId && history.executionIdentity && executionId !== history.executionIdentity) {
      throw new Error("STALE_EXECUTION_JOB");
    }

    const submittedBulkOperationId = history.batch?.shopifyBulkOperation?.id || history.bulkOperationId;
    if (!submittedBulkOperationId || String(submittedBulkOperationId) !== String(bulkOperationId)) {
      throw new Error("SHOPIFY_BULK_OPERATION_MISMATCH");
    }
    if (history.batch?.resultIngestion?.ingestedAt) {
      return {
        skipped: true,
        reason: "already_ingested",
        historyId,
        shop,
      };
    }

    const batchId =
      history.batch?.submittedBatchId
      || history.batch?.shopifyBulkOperation?.batchId
      || history.processingBatchId
      || null;

    const ingestingTransition = await transitionOperation({
      shop,
      operationId: historyId,
      expectedExecutionStates: [
        OPERATION_LIFECYCLE_STATES.QUEUED,
        OPERATION_LIFECYCLE_STATES.WAITING_FOR_SHOPIFY_SLOT,
        OPERATION_LIFECYCLE_STATES.EXECUTING,
        OPERATION_LIFECYCLE_STATES.SHOPIFY_BULK_SUBMITTED,
        OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING,
        OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
        OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
      ],
      nextExecutionState: OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
      expectedFenceToken: Number(history.batch?.executeLeaseFencingToken || 0),
      transitionKey: "bulk_result_ingest_started",
      actor: { type: "worker", id: "bulkEditResultIngestionService" },
      reasonCode: "SHOPIFY_BULK_RESULT_AVAILABLE",
      metadata: { bulkOperationId, attempt, historyId },
      db: db,
    });
    if (!ingestingTransition?.ok) {
      return {
        skipped: true,
        reason: "ingestion_state_claim_lost",
        historyId,
        shop,
      };
    }

    const existingInProgressCheckpoint = await db.editHistoryIngestionCheckpoint.findFirst({
      where: {
        shop,
        historyId,
        status: "IN_PROGRESS",
      },
      orderBy: { updatedAt: "desc" },
    });

    const ingestionRunId = buildIngestionRunId({
      existingCheckpoint: existingInProgressCheckpoint,
      historyId,
      batchId,
      attempt,
    });

    let successCount = Number(existingInProgressCheckpoint?.successCount || 0);
    let failureCount = Number(existingInProgressCheckpoint?.failureCount || 0);
    let rowCount = Number(existingInProgressCheckpoint?.rowCount || 0);
    let unmappedRowCount = Number(existingInProgressCheckpoint?.unmappedRowCount || 0);
    let malformedRowCount = Number(existingInProgressCheckpoint?.malformedRowCount || 0);
    const checkpointMetadata = getCheckpointMetadata(existingInProgressCheckpoint);
    const checkpoint = {
      checkpointVersion: 2,
      ingestionRunId,
      attempt,
      rowOffset: Number(existingInProgressCheckpoint?.rowOffset || 0),
      byteOffset: Number(checkpointMetadata?.byteOffset || 0),
      rowCount,
      successCount,
      failureCount,
      unmappedRowCount,
      malformedRowCount,
      rollingChecksum: String(existingInProgressCheckpoint?.rollingChecksum || ""),
      updatedAt: new Date().toISOString(),
    };

    await db.editHistoryIngestionCheckpoint.upsert({
      where: {
        shop_historyId_ingestionRunId: {
          shop,
          historyId,
          ingestionRunId,
        },
      },
      create: {
        shop,
        historyId,
        ingestionRunId,
        attempt: Number(attempt || 1),
        status: "IN_PROGRESS",
        rowOffset: Number(checkpoint.rowOffset || 0),
        rowCount,
        successCount,
        failureCount,
        unmappedRowCount,
        malformedRowCount,
        rollingChecksum: checkpoint.rollingChecksum,
        metadata: {
          bulkOperationId,
          batchId,
          checkpointVersion: 2,
          byteOffset: Number(checkpoint.byteOffset || 0),
          chunks: Array.isArray(checkpointMetadata?.chunks) ? checkpointMetadata.chunks : [],
        },
      },
      update: {
        attempt: Number(attempt || 1),
        status: "IN_PROGRESS",
        metadata: {
          bulkOperationId,
          batchId,
          checkpointVersion: 2,
          byteOffset: Number(checkpoint.byteOffset || 0),
          chunks: Array.isArray(checkpointMetadata?.chunks) ? checkpointMetadata.chunks : [],
        },
      },
    });

    const pendingUpdates = [];
    const FLUSH_SIZE = 500;

    let chunkStartRow = Number(checkpoint.rowOffset || 0) + 1;
    let chunkStartByteOffset = Number(checkpoint.byteOffset || 0);
    let chunkSuccessCount = 0;
    let chunkFailureCount = 0;
    let chunkUnmappedRowCount = 0;
    let chunkMalformedRowCount = 0;

    const flushCheckpoint = async ({ closeChunk = false } = {}) => {
      checkpoint.rowOffset = rowCount;
      checkpoint.rowCount = rowCount;
      checkpoint.successCount = successCount;
      checkpoint.failureCount = failureCount;
      checkpoint.unmappedRowCount = unmappedRowCount;
      checkpoint.malformedRowCount = malformedRowCount;
      checkpoint.updatedAt = new Date().toISOString();

      if (closeChunk && rowCount >= chunkStartRow) {
        checkpointMetadata.chunks = appendIngestionChunk(checkpointMetadata, {
          startRow: chunkStartRow,
          endRow: rowCount,
          startByteOffset: chunkStartByteOffset,
          endByteOffset: Number(checkpoint.byteOffset || 0),
          successCount: chunkSuccessCount,
          failureCount: chunkFailureCount,
          unmappedRowCount: chunkUnmappedRowCount,
          malformedRowCount: chunkMalformedRowCount,
          rollingChecksum: checkpoint.rollingChecksum,
          completedAt: new Date().toISOString(),
        });
        chunkStartRow = rowCount + 1;
        chunkStartByteOffset = Number(checkpoint.byteOffset || 0);
        chunkSuccessCount = 0;
        chunkFailureCount = 0;
        chunkUnmappedRowCount = 0;
        chunkMalformedRowCount = 0;
      }

      await db.editHistoryIngestionCheckpoint.updateMany({
        where: {
          shop,
          historyId,
          ingestionRunId,
          status: "IN_PROGRESS",
        },
        data: {
          rowOffset: Number(checkpoint.rowOffset || 0),
          rowCount: Number(checkpoint.rowCount || 0),
          successCount: Number(checkpoint.successCount || 0),
          failureCount: Number(checkpoint.failureCount || 0),
          unmappedRowCount: Number(checkpoint.unmappedRowCount || 0),
          malformedRowCount: Number(checkpoint.malformedRowCount || 0),
          rollingChecksum: String(checkpoint.rollingChecksum || ""),
          metadata: {
            bulkOperationId,
            batchId,
            checkpointVersion: checkpoint.checkpointVersion,
            byteOffset: Number(checkpoint.byteOffset || 0),
            chunks: Array.isArray(checkpointMetadata?.chunks) ? checkpointMetadata.chunks : [],
          },
        },
      });
    };

    const flushPending = async () => {
      if (!pendingUpdates.length) return;
      const updates = pendingUpdates.splice(0, pendingUpdates.length);
      const groups = groupPendingUpdates(updates);
      const results = await Promise.all(
        groups.map((group) => mergeChangeRecordIngestionOptions({
          shop,
          historyId,
          batchId,
          group,
          attempt,
        })),
      );
      for (let i = 0; i < results.length; i += 1) {
        const count = Number(results[i]?.count || 0);
        const row = groups[i];
        const expectedCount = row.targetIdentities.length;
        const missedCount = Math.max(expectedCount - count, 0);
        if (!count) {
          unmappedRowCount += expectedCount;
          chunkUnmappedRowCount += expectedCount;
          continue;
        }
        if (missedCount) {
          unmappedRowCount += missedCount;
          chunkUnmappedRowCount += missedCount;
        }
        if (row.status === "SUCCESS") successCount += count;
        else failureCount += count;
        if (row.status === "SUCCESS") chunkSuccessCount += count;
        else chunkFailureCount += count;
      }
      await flushCheckpoint({ closeChunk: true });
    };

    await processJsonlLinesFromCheckpoint(resultUrl, checkpoint, async (line, absoluteRow, nextByteOffset) => {
      if (leaseHeartbeatLost) {
        throw new Error("RESULT_INGEST_LEASE_HEARTBEAT_LOST");
      }
      rowCount = Number(absoluteRow || (rowCount + 1));
      checkpoint.byteOffset = Number(nextByteOffset || checkpoint.byteOffset || 0);
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        malformedRowCount += 1;
        chunkMalformedRowCount += 1;
        checkpoint.rollingChecksum = checkpointChecksum(
          checkpoint.rollingChecksum,
          `malformed:${rowCount}:${line.slice(0, 256)}`,
        );
        await flushCheckpoint();
        return;
      }
      const item = extractRowResult(parsed);
      if (!item.targetIdentity) {
        unmappedRowCount += 1;
        chunkUnmappedRowCount += 1;
        checkpoint.rollingChecksum = checkpointChecksum(
          checkpoint.rollingChecksum,
          `unmapped:${rowCount}`,
        );
        await flushCheckpoint();
        return;
      }
      checkpoint.rollingChecksum = checkpointChecksum(
        checkpoint.rollingChecksum,
        `${rowCount}:${item.targetIdentity}:${item.status}`,
      );

      pendingUpdates.push({
        targetIdentity: item.targetIdentity,
        status: item.status === "SUCCESS" ? "SUCCESS" : "FAILED",
        shopifyUserErrors: item.shopifyUserErrors || [],
      });
      if (pendingUpdates.length >= FLUSH_SIZE) {
        await flushPending();
      }
    });
    await flushPending();
    await flushCheckpoint({ closeChunk: true });

    const latestBeforeCompletion = await db.editHistory.findFirst({
      where: { id: historyId, shop },
      select: { batch: true },
    });

    const completedUpdate = await guardedEditHistoryUpdate({
      id: historyId,
      shop,
      expectedExecutionStates: [OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS],
      extraWhere: {
        batch: {
          path: ["resultIngestion", "ingestedAt"],
          equals: null,
        },
      },
      data: {
        processedCount: {
          increment: successCount,
        },
        status: (failureCount > 0 || malformedRowCount > 0 || unmappedRowCount > 0) ? "partial" : "completed",
        statusNormalized: normalizeEditHistoryStatus(
          (failureCount > 0 || malformedRowCount > 0 || unmappedRowCount > 0) ? "partial" : "completed",
        ),
        batch: mergeBatch(latestBeforeCompletion?.batch || history.batch, {
          resultIngestion: {
            ingestedAt: new Date().toISOString(),
            batchId,
            ingestionRunId,
            successCount,
            failureCount,
            unmappedRowCount,
            malformedRowCount,
            rowCount,
            rollingChecksum: checkpoint.rollingChecksum,
            checkpoint,
          },
        }),
      },
      db: db,
    });
    if (!completedUpdate) {
      return {
        skipped: true,
        reason: "already_ingested",
        historyId,
        shop,
        batchId,
        successCount: 0,
        failureCount: 0,
        unmappedRowCount: 0,
        malformedRowCount: 0,
        rowCount: 0,
      };
    }

    const mirrorApplyResult = await applyMirrorFromSuccessfulChangeRecords({
      shop,
      historyId,
    });

    const latestHistory = await db.editHistory.findFirst({
      where: { id: historyId, shop },
      select: { batch: true },
    });

    await db.editHistory.updateMany({
      where: { id: historyId, shop },
      data: {
        batch: mergeBatch(latestHistory?.batch || history.batch, {
          mirrorApply: {
            status: "APPLIED_PENDING_RECONCILE",
            attemptedRows: Number(mirrorApplyResult?.attemptedRows || 0),
            appliedRows: Number(mirrorApplyResult?.appliedRows || 0),
            unresolvedRows: Number(mirrorApplyResult?.unresolvedRows || 0),
            appliedProductRows: Number(mirrorApplyResult?.appliedProductRows || 0),
            appliedVariantRows: Number(mirrorApplyResult?.appliedVariantRows || 0),
            mirrorBatchId: mirrorApplyResult?.mirrorBatchId || null,
            appliedAt: new Date().toISOString(),
          },
        }),
      },
    });

    await schedulePostMutationMirrorReconciliation({
      shop,
      ownerType: "EDIT_HISTORY",
      ownerId: historyId,
      mirrorBatchId: mirrorApplyResult?.mirrorBatchId || undefined,
      source: "BULK_EDIT_EXECUTION_APPLY",
      verificationStatus: (failureCount > 0 || malformedRowCount > 0 || unmappedRowCount > 0) ? "PARTIAL" : "SUCCESS",
    });

    const latestForTransition = await db.editHistory.findFirst({
      where: { id: historyId, shop },
      select: { batch: true },
    });
    const completedTransition = await transitionOperation({
      shop,
      operationId: historyId,
      expectedExecutionStates: [OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS],
      nextExecutionState: OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
      expectedFenceToken: Number(latestForTransition?.batch?.executeLeaseFencingToken || 0),
      transitionKey: "bulk_result_ingest_completed",
      actor: { type: "worker", id: "bulkEditResultIngestionService" },
      reasonCode: (failureCount > 0 || malformedRowCount > 0 || unmappedRowCount > 0)
        ? "SHOPIFY_RESULT_PARTIAL"
        : "SHOPIFY_RESULT_COMPLETE",
      metadata: { bulkOperationId, successCount, failureCount, ingestionRunId },
      db: db,
    });
    if (!completedTransition?.ok) {
      throw new Error(`BULK_RESULT_INGEST_COMPLETION_TRANSITION_REJECTED:${completedTransition?.reason || "UNKNOWN"}`);
    }

    await db.editHistoryIngestionCheckpoint.updateMany({
      where: { shop, historyId, ingestionRunId, status: "IN_PROGRESS" },
      data: {
        status: "COMPLETED",
        rowOffset: Number(rowCount || 0),
        rowCount: Number(rowCount || 0),
        successCount: Number(successCount || 0),
        failureCount: Number(failureCount || 0),
        unmappedRowCount: Number(unmappedRowCount || 0),
        malformedRowCount: Number(malformedRowCount || 0),
        rollingChecksum: String(checkpoint.rollingChecksum || ""),
        metadata: {
          bulkOperationId,
          batchId,
          completedAt: new Date().toISOString(),
        },
      },
    });

    return {
      historyId,
      shop,
      batchId,
      successCount,
      failureCount,
      unmappedRowCount,
      malformedRowCount,
      rowCount,
      rollingChecksum: checkpoint.rollingChecksum,
    };
    } finally {
      clearInterval(leaseHeartbeat);
      await releaseOperationLease({
        shop,
        namespace: "BULK_EDIT_RESULT_INGEST",
        resourceId: String(historyId),
        ownerId: leaseOwnerId,
      });
    }
  }
}
