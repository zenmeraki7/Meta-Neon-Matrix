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
import { guardedEditHistoryUpdate } from "../../services/operationTransitionGuards.js";
import { loadAuthoritativeSubscriptionForShop } from "../../services/subscriptionAuthorityService.js";
import { getPlanMaxBulkEditTargets } from "../../services/bulkEdit/bulkEditPlanUtils.js";
import { upsertOperationStageProgress } from "../../services/operationStageProgressService.js";
import {
  acquireOperationLease,
  assertOperationLeaseOwnership,
  buildLeaseOwnerId,
  heartbeatOperationLease,
  releaseOperationLease,
} from "../../services/operationLeaseService.js";
import { getFrozenSnapshotSetForExecution } from "../../repositories/targetSnapshotSetRepository.js";

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
  const payload = job.data || {};
  const { historyId, operationId, snapshotSetId, shop, executionId } = payload;
  const forbiddenScopeKeys = [
    "filterAst",
    "filterParams",
    "productIds",
    "variantIds",
    "collectionIds",
    "targetIds",
    "explicitProductIds",
    "explicitVariantIds",
  ];
  for (const key of forbiddenScopeKeys) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      throw new Error(`EXECUTE_SCOPE_PAYLOAD_FORBIDDEN:${key}`);
    }
  }

  const resolvedOperationId = String(operationId || historyId || "").trim();
  if (!resolvedOperationId) {
    throw new Error("operationId is required");
  }

  if (!shop) {
    throw new Error("shop is required");
  }

  if (!executionId) {
    throw new Error("executionId is required");
  }

  return {
    historyId: resolvedOperationId,
    operationId: resolvedOperationId,
    snapshotSetId: String(snapshotSetId || "").trim() || null,
    shop,
    executionId,
    source: payload?.source || "bulk_edit_execute_worker",
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
      snapshotSetId: true,
      cancelRequestedAt: true,
      targetSnapshotCount: true,
      processedCount: true,
      totalItems: true,
    },
  });
}

function assertSnapshotSetBoundToOperation({ history, snapshotSetId }) {
  const lifecycleSnapshotSetId = String(history?.snapshotSetId || "").trim();
  const batchSnapshotSetId = String(
    history?.batch?.targetSnapshotRef?.snapshotSetId || "",
  ).trim();
  const expected = lifecycleSnapshotSetId || batchSnapshotSetId;
  if (!expected) {
    throw new Error("OPERATION_SNAPSHOT_SET_UNBOUND");
  }
  if (String(snapshotSetId || "").trim() !== expected) {
    throw new Error("OPERATION_SNAPSHOT_SET_MISMATCH");
  }
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

function assertExecuteEntitlement({ history, authoritativeSubscription }) {
  const count = Number(history?.targetSnapshotCount || history?.totalItems || 0);
  const limit = Number(authoritativeSubscription?.limit || 100);
  const isUnlimited = Boolean(authoritativeSubscription?.isUnlimited);
  const planName = authoritativeSubscription?.planName || "Free Plan";
  const maxBulkEditTargets = getPlanMaxBulkEditTargets(authoritativeSubscription);

  if (!isUnlimited && count > limit) {
    throw new Error(
      `ENTITLEMENT_LIMIT_EXCEEDED:${planName}:${limit}:${count}`,
    );
  }
  if (count > maxBulkEditTargets) {
    throw new Error("TARGET_COUNT_EXCEEDS_PLAN_LIMIT");
  }
}

async function markExecuting({ historyId, shop, batchPatch = {} }) {
  const existing = await prisma.editHistory.findFirst({
    where: { id: historyId, shop },
    select: { batch: true },
  });

  const updated = await guardedEditHistoryUpdate({
    id: historyId,
    shop,
    expectedExecutionStates: [
      OPERATION_LIFECYCLE_STATES.PLANNED,
      OPERATION_LIFECYCLE_STATES.QUEUED,
      OPERATION_LIFECYCLE_STATES.SCHEDULED_QUEUED,
      OPERATION_LIFECYCLE_STATES.WAITING_FOR_SHOPIFY_SLOT,
    ],
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
  if (!updated) {
    throw new Error("EDIT_HISTORY_UPDATE_FAILED_MARK_EXECUTING");
  }
  await upsertOperationStageProgress({
    shop,
    operationType: "BULK_EDIT",
    operationId: historyId,
    stageKey: "EXECUTING",
    stageStatus: "RUNNING",
  });
}

async function assertExecuteLeaseActive({ shop, historyId, leaseOwnerId }) {
  await assertOperationLeaseOwnership({
    shop,
    namespace: "BULK_EDIT_EXECUTE",
    resourceId: String(historyId),
    ownerId: leaseOwnerId,
  });
}

async function markCompletedEmpty({ historyId, shop, batchId }) {
  const existing = await prisma.editHistory.findFirst({
    where: { id: historyId, shop },
    select: { batch: true },
  });

  const updated = await guardedEditHistoryUpdate({
    id: historyId,
    shop,
    expectedExecutionStates: [
      OPERATION_LIFECYCLE_STATES.EXECUTING,
      OPERATION_LIFECYCLE_STATES.WAITING_FOR_SHOPIFY_SLOT,
      OPERATION_LIFECYCLE_STATES.PLANNED,
      OPERATION_LIFECYCLE_STATES.QUEUED,
    ],
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
  if (!updated) {
    throw new Error("EDIT_HISTORY_UPDATE_FAILED_MARK_COMPLETED_EMPTY");
  }
  await upsertOperationStageProgress({
    shop,
    operationType: "BULK_EDIT",
    operationId: historyId,
    stageKey: "EXECUTING",
    stageStatus: "COMPLETED_EMPTY",
    completed: true,
  });
}

async function countRemainingFrozenTargets({ snapshotSetId, shop, cursorTargetKey }) {
  return prisma.targetSnapshotItem.count({
    where: {
      shop,
      snapshotSetId,
      ...(typeof cursorTargetKey === "string" && cursorTargetKey.trim()
        ? { targetKey: { gt: cursorTargetKey } }
        : {}),
    },
  });
}

async function resolveEmptyBatchCursorOrdinal({
  historyId,
  shop,
  preparedBatch,
  history,
}) {
  if (
    typeof preparedBatch?.lastProductId === "string" &&
    preparedBatch.lastProductId.trim()
  ) {
    return preparedBatch.lastProductId;
  }

  if (
    typeof history?.batch?.lastProductId === "string" &&
    history.batch.lastProductId.trim()
  ) {
    return history.batch.lastProductId;
  }

  const latest = await prisma.editHistory.findFirst({
    where: { id: historyId, shop },
    select: { batch: true },
  });

  if (
    typeof latest?.batch?.lastProductId === "string" &&
    latest.batch.lastProductId.trim()
  ) {
    return latest.batch.lastProductId;
  }

  return null;
}

async function isFrozenCursorExhausted({ snapshotSetId, shop, cursorOrdinal }) {
  const maxRow = await prisma.targetSnapshotItem.findFirst({
    where: {
      shop,
      snapshotSetId,
    },
    orderBy: [{ targetKey: "desc" }],
    select: { targetKey: true },
  });
  const maxTargetKey = String(maxRow?.targetKey || "").trim();
  if (!maxTargetKey) {
    return true;
  }
  if (typeof cursorOrdinal !== "string" || !cursorOrdinal.trim()) {
    return false;
  }
  return cursorOrdinal >= maxTargetKey;
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

  const updated = await guardedEditHistoryUpdate({
    id: historyId,
    shop,
    expectedExecutionStates: [
      OPERATION_LIFECYCLE_STATES.EXECUTING,
      OPERATION_LIFECYCLE_STATES.QUEUED,
      OPERATION_LIFECYCLE_STATES.WAITING_FOR_SHOPIFY_SLOT,
      OPERATION_LIFECYCLE_STATES.SCHEDULED_QUEUED,
    ],
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
  if (!updated) {
    throw new Error("EDIT_HISTORY_UPDATE_FAILED_MARK_WAITING_SLOT");
  }
  await upsertOperationStageProgress({
    shop,
    operationType: "BULK_EDIT",
    operationId: historyId,
    stageKey: "WAITING_FOR_SHOPIFY_SLOT",
    stageStatus: "WAITING",
    detail: {
      delayMs,
      currentBulkOperation: currentBulkOperation || null,
    },
  });
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

  const updated = await guardedEditHistoryUpdate({
    id: historyId,
    shop,
    expectedExecutionStates: [
      OPERATION_LIFECYCLE_STATES.PLANNED,
      OPERATION_LIFECYCLE_STATES.QUEUED,
      OPERATION_LIFECYCLE_STATES.SCHEDULED_QUEUED,
      OPERATION_LIFECYCLE_STATES.WAITING_FOR_SHOPIFY_SLOT,
      OPERATION_LIFECYCLE_STATES.EXECUTING,
      OPERATION_LIFECYCLE_STATES.SHOPIFY_BULK_SUBMITTED,
      OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING,
      OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
    ],
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
  if (!updated) {
    throw new Error("EDIT_HISTORY_UPDATE_FAILED_MARK_FAILED");
  }
  await upsertOperationStageProgress({
    shop,
    operationType: "BULK_EDIT",
    operationId: historyId,
    stageKey: "EXECUTING",
    stageStatus: "FAILED",
    detail: {
      failureStage,
      message: error?.message || String(error),
    },
    completed: true,
  });
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
  const { historyId, snapshotSetId, shop, executionId, source } = payload;

  let lock = null;
  let executeLeaseOwnerId = null;
  let executeLeaseHeartbeat = null;

  try {
    const history = await loadExecutionHistory({ historyId, shop });

    assertHistoryRunnable({
      history,
      historyId,
      shop,
      executionId,
    });
    const resolvedSnapshotSetId = String(
      snapshotSetId || history?.snapshotSetId || history?.batch?.targetSnapshotRef?.snapshotSetId || "",
    ).trim();
    if (!resolvedSnapshotSetId) {
      throw new Error("SNAPSHOT_SET_ID_REQUIRED");
    }
    assertSnapshotSetBoundToOperation({
      history,
      snapshotSetId: resolvedSnapshotSetId,
    });
    const resolvedSnapshotSetOperationId = String(
      history?.batch?.targetSnapshotRef?.operationId
      || history?.executionIdentity
      || "",
    ).trim();
    await getFrozenSnapshotSetForExecution({
      shop,
      snapshotSetId: resolvedSnapshotSetId,
      operationId: resolvedSnapshotSetOperationId || undefined,
      db: prisma,
    });
    const authoritativeSubscription = await loadAuthoritativeSubscriptionForShop(shop);
    assertExecuteEntitlement({
      history,
      authoritativeSubscription,
    });

    lock = await acquireExclusiveShopWork({
      shop,
      // Serialize bulk execute jobs per shop while allowing cross-shop parallelism.
      namespace: LOCK_NS.BULK_EDIT_EXECUTE,
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

    executeLeaseOwnerId = buildLeaseOwnerId("bulk-edit-execute");
    const executeLease = await acquireOperationLease({
      shop,
      namespace: "BULK_EDIT_EXECUTE",
      resourceId: String(historyId),
      ownerId: executeLeaseOwnerId,
    });
    if (!executeLease?.acquired) {
      const delayMs = DEFAULT_REQUEUE_DELAY_MS;
      await addBulkEditExecuteJob(
        {
          historyId,
          shop,
          executionId,
          source: `${source}:execute_lease_busy`,
        },
        { delay: delayMs },
      );
      return {
        success: true,
        requeued: true,
        reason: "BULK_EDIT_EXECUTE_LEASE_BUSY",
        delayMs,
      };
    }

    executeLeaseHeartbeat = setInterval(() => {
      heartbeatOperationLease({
        shop,
        namespace: "BULK_EDIT_EXECUTE",
        resourceId: String(historyId),
        ownerId: executeLeaseOwnerId,
      }).catch(() => {});
    }, 30_000);

    await markExecuting({
      historyId,
      shop,
      batchPatch: {
        executeLeaseOwnerId,
        executeLeaseFencingToken: Number(executeLease.fencingToken || 0),
      },
    });
    await upsertOperationStageProgress({
      shop,
      operationType: "BULK_EDIT",
      operationId: historyId,
      executionId,
      stageKey: "EXECUTING",
      stageStatus: "RUNNING",
      detail: {
        executeLeaseOwnerId,
        executeLeaseFencingToken: Number(executeLease.fencingToken || 0),
      },
    });

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
    await assertExecuteLeaseActive({
      shop,
      historyId,
      leaseOwnerId: executeLeaseOwnerId,
    });

    if (!preparedBatch.batchTargetCount || !preparedBatch.formattedProducts) {
      const cursorOrdinal = await resolveEmptyBatchCursorOrdinal({
        historyId,
        shop,
        preparedBatch,
        history,
      });
      const remaining = await countRemainingFrozenTargets({
        snapshotSetId: resolvedSnapshotSetId,
        shop,
        cursorTargetKey: cursorOrdinal,
      });
      const exhausted = await isFrozenCursorExhausted({
        snapshotSetId: resolvedSnapshotSetId,
        shop,
        cursorOrdinal,
      });
      if (remaining > 0 || !exhausted) {
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
      submitFence: {
        leaseOwnerId: executeLeaseOwnerId,
        fencingToken: Number(executeLease.fencingToken || 0),
      },
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
    if (executeLeaseHeartbeat) {
      clearInterval(executeLeaseHeartbeat);
    }
    if (executeLeaseOwnerId) {
      await releaseOperationLease({
        shop,
        namespace: "BULK_EDIT_EXECUTE",
        resourceId: String(historyId),
        ownerId: executeLeaseOwnerId,
      });
    }
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
