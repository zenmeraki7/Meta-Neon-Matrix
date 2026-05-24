import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { Worker } from "bullmq";
import shopify from "../../shopify.js";
import { prisma } from "../../config/database.js";
import { connection as redisConnection } from "../../config/redis.js";
import { addBulkEditExecuteJob } from "../Queues/bulkEditExecuteJob.js";
import {
  acquireExclusiveShopWork,
  releaseExclusiveShopWork,
  LOCK_NS,
} from "../../services/shopWorkLeaseService.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../../services/operationLifecycleStateMachine.js";
import { BulkEditExecutionPreparationService } from "../../services/bulkEdit/BulkEditExecutionPreparationService.js";
import { ShopifyBulkMutationService } from "../../services/bulkEdit/ShopifyBulkMutationService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const WORKER_NAME = "bulkEditExecuteWorker";
const OPERATION_QUEUE_NAMES = {
  BULK_EDIT_EXECUTE: process.env.BULK_EDIT_EXECUTE_QUEUE || "bulk-edit-execute",
};

const DEFAULT_REQUEUE_DELAY_MS = Number.parseInt(
  process.env.BULK_EDIT_SHOPIFY_SLOT_REQUEUE_DELAY_MS || "60000",
  10,
);

const WORKER_CONCURRENCY = Number.parseInt(
  process.env.BULK_EDIT_EXECUTE_WORKER_CONCURRENCY || "2",
  10,
);

function assertJobPayload(job) {
  const { historyId, shop, executionId } = job.data || {};

  if (!historyId) {
    throw new Error("historyId is required");
  }

  if (!shop) {
    throw new Error("shop is required");
  }

  if (!executionId) {
    throw new Error("executionId is required");
  }

  return {
    historyId,
    shop,
    executionId,
    source: job.data?.source || "bulk_edit_execute_worker",
  };
}

function buildSessionForShop(shop) {
  const offlineSessionId = shopify.api.session.getOfflineId(shop);
  return shopify.config.sessionStorage.loadSession(offlineSessionId);
}

function mergeBatch(existingBatch, patch) {
  return {
    ...(existingBatch && typeof existingBatch === "object" ? existingBatch : {}),
    ...patch,
  };
}

async function loadExecutionHistory({ historyId, shop }) {
  return prisma.editHistory.findFirst({
    where: {
      id: historyId,
      shop,
    },
    select: {
      id: true,
      shop: true,
      batch: true,
      status: true,
      executionState: true,
      executionIdentity: true,
      cancelRequestedAt: true,
      targetSnapshotCount: true,
      processedCount: true,
      totalItems: true,
    },
  });
}

function assertHistoryRunnable({ history, historyId, shop, executionId }) {
  if (!history) {
    throw new Error("Edit history not found");
  }

  if (history.id !== historyId || history.shop !== shop) {
    throw new Error("EDIT_HISTORY_JOB_MISMATCH");
  }

  if (
    executionId &&
    history.executionIdentity &&
    executionId !== history.executionIdentity
  ) {
    throw new Error("STALE_EXECUTION_JOB");
  }

  if (history.cancelRequestedAt) {
    throw new Error("OPERATION_CANCEL_REQUESTED");
  }

  const terminalStates = new Set([
    OPERATION_LIFECYCLE_STATES.COMPLETED,
    OPERATION_LIFECYCLE_STATES.PARTIAL_FAILED,
    OPERATION_LIFECYCLE_STATES.FAILED,
    OPERATION_LIFECYCLE_STATES.CANCELLED,
  ]);

  if (terminalStates.has(history.executionState)) {
    throw new Error(`OPERATION_ALREADY_TERMINAL:${history.executionState}`);
  }

  const alreadySubmitted =
    history.batch?.shopifyBulkOperation?.id ||
    history.batch?.shopifyBulkOperationId;

  if (alreadySubmitted) {
    throw new Error("SHOPIFY_BULK_OPERATION_ALREADY_SUBMITTED");
  }
}

async function markExecuting({ historyId, shop, batchPatch = {} }) {
  const existing = await prisma.editHistory.findFirst({
    where: { id: historyId, shop },
    select: { batch: true },
  });

  const updated = await prisma.editHistory.updateMany({
    where: { id: historyId, shop },
    data: {
      executionState: OPERATION_LIFECYCLE_STATES.EXECUTING,
      executionStateNormalized: normalizeEditHistoryExecutionState(
        OPERATION_LIFECYCLE_STATES.EXECUTING,
      ),
      batch: mergeBatch(existing?.batch, {
        executionWorker: WORKER_NAME,
        executionStartedAt: new Date().toISOString(),
        ...batchPatch,
      }),
    },
  });
  if (updated.count !== 1) {
    throw new Error("EDIT_HISTORY_UPDATE_FAILED_MARK_EXECUTING");
  }
}

async function markCompletedEmpty({ historyId, shop, batchId }) {
  const existing = await prisma.editHistory.findFirst({
    where: { id: historyId, shop },
    select: { batch: true },
  });

  const updated = await prisma.editHistory.updateMany({
    where: { id: historyId, shop },
    data: {
      status: "completed",
      statusNormalized: normalizeEditHistoryStatus("completed"),
      executionState: OPERATION_LIFECYCLE_STATES.COMPLETED,
      executionStateNormalized: normalizeEditHistoryExecutionState(
        OPERATION_LIFECYCLE_STATES.COMPLETED,
      ),
      completedAt: new Date(),
      batch: mergeBatch(existing?.batch, {
        completedReason: "NO_MORE_FROZEN_TARGETS",
        completedEmptyBatchId: batchId || null,
        completedAt: new Date().toISOString(),
        hasMore: false,
      }),
    },
  });
  if (updated.count !== 1) {
    throw new Error("EDIT_HISTORY_UPDATE_FAILED_MARK_COMPLETED_EMPTY");
  }
}

async function countRemainingFrozenTargets({ historyId, shop, cursorOrdinal }) {
  return prisma.targetSnapshot.count({
    where: {
      ownerType: "EDIT_HISTORY",
      ownerId: historyId,
      shop,
      ...(Number.isInteger(cursorOrdinal)
        ? { ordinal: { gt: cursorOrdinal } }
        : {}),
    },
  });
}

async function markWaitingForShopifySlot({
  historyId,
  shop,
  currentBulkOperation,
  delayMs,
}) {
  const existing = await prisma.editHistory.findFirst({
    where: { id: historyId, shop },
    select: { batch: true },
  });

  const updated = await prisma.editHistory.updateMany({
    where: { id: historyId, shop },
    data: {
      executionState: OPERATION_LIFECYCLE_STATES.WAITING_FOR_SHOPIFY_SLOT,
      executionStateNormalized: normalizeEditHistoryExecutionState(
        OPERATION_LIFECYCLE_STATES.WAITING_FOR_SHOPIFY_SLOT,
      ),
      batch: mergeBatch(existing?.batch, {
        waitingForShopifySlot: true,
        waitingForShopifySlotAt: new Date().toISOString(),
        shopifySlotRetryDelayMs: delayMs,
        currentShopifyBulkOperation: currentBulkOperation || null,
      }),
    },
  });
  if (updated.count !== 1) {
    throw new Error("EDIT_HISTORY_UPDATE_FAILED_MARK_WAITING_SLOT");
  }
}

async function markFailed({
  historyId,
  shop,
  error,
  failureStage = "BULK_EDIT_EXECUTE_WORKER",
}) {
  const existing = await prisma.editHistory.findFirst({
    where: { id: historyId, shop },
    select: { batch: true },
  });

  const updated = await prisma.editHistory.updateMany({
    where: { id: historyId, shop },
    data: {
      status: "failed",
      statusNormalized: normalizeEditHistoryStatus("failed"),
      executionState: OPERATION_LIFECYCLE_STATES.FAILED,
      executionStateNormalized: normalizeEditHistoryExecutionState(
        OPERATION_LIFECYCLE_STATES.FAILED,
      ),
      failureStage,
      completedAt: new Date(),
      batch: mergeBatch(existing?.batch, {
        failedAt: new Date().toISOString(),
        failureStage,
        failureMessage: error?.message || String(error),
        failureStack:
          process.env.NODE_ENV === "production" ? undefined : error?.stack,
      }),
    },
  });
  if (updated.count !== 1) {
    throw new Error("EDIT_HISTORY_UPDATE_FAILED_MARK_FAILED");
  }
}

async function requeueForShopifySlot({
  historyId,
  shop,
  executionId,
  source,
  delayMs,
}) {
  await addBulkEditExecuteJob(
    {
      historyId,
      shop,
      executionId,
      source: `${source}:waiting_for_shopify_slot`,
    },
    {
      delay: delayMs,
    },
  );
}

async function processBulkEditExecuteJob(job) {
  const payload = assertJobPayload(job);
  const { historyId, shop, executionId, source } = payload;

  let lock = null;

  try {
    const history = await loadExecutionHistory({ historyId, shop });

    assertHistoryRunnable({
      history,
      historyId,
      shop,
      executionId,
    });

    lock = await acquireExclusiveShopWork({
      shop,
      namespace: LOCK_NS.WRITE_CATALOG,
      activity: "bulk_edit_execute",
      worker: WORKER_NAME,
      queue: OPERATION_QUEUE_NAMES.BULK_EDIT_EXECUTE,
      operationId: historyId,
      executionId,
    });

    if (!lock?.acquired) {
      const delayMs = DEFAULT_REQUEUE_DELAY_MS;

      await addBulkEditExecuteJob(
        {
          historyId,
          shop,
          executionId,
          source: `${source}:catalog_lock_busy`,
        },
        {
          delay: delayMs,
        },
      );

      return {
        success: true,
        requeued: true,
        reason: "WRITE_CATALOG_LOCK_BUSY",
        delayMs,
      };
    }

    await markExecuting({ historyId, shop });

    const session = await buildSessionForShop(shop);

    if (!session) {
      throw new Error("Offline Shopify session not found");
    }

    const client = new shopify.api.clients.Graphql({ session });

    const preparationService = new BulkEditExecutionPreparationService(session);

    const mutationService = new ShopifyBulkMutationService(session, client);

    const preparedBatch = await preparationService.prepareNextExecutionBatch({
      historyId,
      executionId,
    });

    if (!preparedBatch.batchTargetCount || !preparedBatch.formattedProducts) {
      const remaining = await countRemainingFrozenTargets({
        historyId,
        shop,
        cursorOrdinal: Number.isInteger(history.batch?.lastProductId)
          ? history.batch.lastProductId
          : null,
      });
      if (remaining > 0) {
        throw new Error("EMPTY_PREPARED_BATCH_WITH_REMAINING_FROZEN_TARGETS");
      }
      await markCompletedEmpty({
        historyId,
        shop,
        batchId: preparedBatch.batchId,
      });

      return {
        success: true,
        completed: true,
        reason: "NO_MORE_FROZEN_TARGETS",
        historyId,
      };
    }

    const submission = await mutationService.submitProductSetBulkMutation({
      historyId,
      executionId,
      formattedProducts: preparedBatch.formattedProducts,
      fields: preparedBatch.fields,
      batchId: preparedBatch.batchId,
      batchTargetCount: preparedBatch.batchTargetCount,
      lastProductId: preparedBatch.lastProductId,
      hasMore: preparedBatch.hasMore,
      nextRetryCursorIndex: preparedBatch.nextRetryCursorIndex,
    });

    if (submission.waitingForShopifySlot) {
      const delayMs = DEFAULT_REQUEUE_DELAY_MS;

      await markWaitingForShopifySlot({
        historyId,
        shop,
        currentBulkOperation: submission.currentBulkOperation,
        delayMs,
      });

      await requeueForShopifySlot({
        historyId,
        shop,
        executionId,
        source,
        delayMs,
      });

      return {
        success: true,
        submitted: false,
        waitingForShopifySlot: true,
        requeued: true,
        delayMs,
      };
    }

    return {
      success: true,
      submitted: true,
      historyId,
      bulkOperationId: submission.bulkOperationId,
      batchId: submission.batchId,
      batchTargetCount: submission.batchTargetCount,
      hasMore: submission.hasMore,
      message: "Shopify bulk mutation submitted. Waiting for webhook/result ingestion.",
    };
  } catch (error) {
    const nonFailureErrors = new Set([
      "STALE_EXECUTION_JOB",
      "OPERATION_CANCEL_REQUESTED",
      "SHOPIFY_BULK_OPERATION_ALREADY_SUBMITTED",
    ]);

    const message = error?.message || String(error);

    if ([...nonFailureErrors].some((code) => message.includes(code))) {
      return {
        success: false,
        ignored: true,
        reason: message,
      };
    }

    await markFailed({
      historyId,
      shop,
      error,
    });

    throw error;
  } finally {
    if (lock?.lockKey) {
      await releaseExclusiveShopWork(lock.lockKey);
    }
  }
}

export const bulkEditExecuteWorker = new Worker(
  OPERATION_QUEUE_NAMES.BULK_EDIT_EXECUTE,
  processBulkEditExecuteJob,
  {
    connection: redisConnection,
    concurrency: Number.isFinite(WORKER_CONCURRENCY)
      ? WORKER_CONCURRENCY
      : 2,
    autorun: false,
  },
);

bulkEditExecuteWorker.on("completed", (job, result) => {
  console.log("[bulkEditExecuteWorker] completed", {
    jobId: job.id,
    historyId: job.data?.historyId,
    shop: job.data?.shop,
    result,
  });
});

bulkEditExecuteWorker.on("failed", (job, error) => {
  console.error("[bulkEditExecuteWorker] failed", {
    jobId: job?.id,
    historyId: job?.data?.historyId,
    shop: job?.data?.shop,
    error: error?.message || String(error),
  });
});

bulkEditExecuteWorker.on("error", (error) => {
  console.error("[bulkEditExecuteWorker] worker error", {
    error: error?.message || String(error),
  });
});

export function startBulkEditExecuteWorker() {
  if (!bulkEditExecuteWorker.isRunning()) {
    bulkEditExecuteWorker.run();
  }

  return bulkEditExecuteWorker;
}

export default bulkEditExecuteWorker;
