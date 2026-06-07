import { QueueEvents, Worker } from "bullmq";
import shopify from "../../shopify.js";
import {
  connection as redisConnection,
  createRedisConnection,
} from "../../config/redis.js";
import logger from "../../utils/loggerUtils.js";
import { addBulkEditExecuteJob } from "../Queues/bulkEditExecuteJob.js";
import {
  acquireExclusiveShopWork,
  releaseExclusiveShopWork,
  LOCK_NS,
} from "../../services/shopWorkLeaseService.js";
import {
  OPERATION_LIFECYCLE_STATES,
} from "../../services/operationLifecycleStateMachine.js";
import { BulkEditExecutionPreparationService } from "../../services/bulkEdit/BulkEditExecutionPreparationService.js";
import { ShopifyBulkMutationService } from "../../services/bulkEdit/ShopifyBulkMutationService.js";
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
import {
  SHOPIFY_BULK_MUTATION_SLOT,
  SHOPIFY_BULK_MUTATION_SLOT_TTL_MS,
  acquireShopifyBulkMutationSlot,
  releaseShopifyBulkMutationSlot,
  shopifyBulkMutationSlotResourceId,
} from "../../services/shopifyBulkMutationSlotLease.js";
import { getFrozenSnapshotSetForExecution } from "../../repositories/targetSnapshotSetRepository.js";
import {
  casMarkFailedNonTerminal,
  casTransitionExecutionState,
  countRemainingSnapshotItems,
  findExecutionHistory,
  findHistoryBatch,
  findMaxSnapshotTargetKey,
} from "../../repositories/bulkEditExecutionRepository.js";
import { toWorkerOperationStatusDto } from "../../dtos/workerOperationStatusDto.js";
import { bulkEditExecuteDlqQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";
import { assertMirrorSafeForBulkExecution } from "../../services/mirrorHealthService.js";
import { runBulkEditPreflight } from "../../services/bulkEdit/BulkEditPreflightService.js";
import {
  CircuitOpenError,
  executeWithShopifyCircuit,
} from "../../services/shopify/ShopifyCircuitBreaker.js";
import {
  suspendBulkEditForShopifyOutage,
  suspensionDelayMs,
} from "../../services/bulkEdit/bulkOperationSuspensionService.js";

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
const LEASE_HEARTBEAT_INTERVAL_MS = Number.parseInt(
  process.env.BULK_EDIT_EXECUTE_LEASE_HEARTBEAT_MS || "20000",
  10,
);
const WORKER_LIMIT_MAX = Number.parseInt(
  process.env.BULK_EDIT_EXECUTE_LIMIT_MAX || "5",
  10,
);
const WORKER_LIMIT_DURATION_MS = Number.parseInt(
  process.env.BULK_EDIT_EXECUTE_LIMIT_DURATION_MS || "1000",
  10,
);

function getMaxAttempts(job) {
  return Number(job?.opts?.attempts || 1);
}

function willExhaustRetryFromProcessor(job) {
  return Number(job?.attemptsMade || 0) + 1 >= getMaxAttempts(job);
}

function isRetryableExecuteError(error) {
  const message = String(error?.message || "");
  const status = error?.response?.status || error?.statusCode || error?.status;
  return (
    error?.retryable === true
    || status === 429
    || status >= 500
    || message.includes("ECONNRESET")
    || message.includes("ETIMEDOUT")
    || message.includes("LEASE")
    || message.includes("LOCK")
    || message.includes("RESULT_URL_")
    || message.includes("RETRYABLE")
  );
}

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

  if (!operationId && historyId) {
    logger.warn("bulkEditExecuteJob: operationId missing, falling back to historyId", {
      worker: WORKER_NAME,
      queue: OPERATION_QUEUE_NAMES.BULK_EDIT_EXECUTE,
      historyId: String(historyId),
      shop,
    });
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

async function buildSessionForShop(shop) {
  const offlineSessionId = shopify.api.session.getOfflineId(shop);
  const session = await shopify.config.sessionStorage.loadSession(offlineSessionId);
  const normalize = (v) => String(v || "").toLowerCase().replace(/\/$/, "");
  if (!session?.accessToken || normalize(session.shop) !== normalize(shop)) {
    const error = new Error("OFFLINE_SESSION_NOT_FOUND_OR_MISMATCHED");
    error.nonRetryable = true;
    throw error;
  }
  return session;
}

function mergeBatch(existingBatch, patch) {
  return {
    ...(existingBatch && typeof existingBatch === "object" ? existingBatch : {}),
    ...patch,
  };
}

async function loadExecutionHistory({ historyId, shop }) {
  return findExecutionHistory(historyId, shop);
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
  const existing = await findHistoryBatch(historyId, shop);

  const updated = await casTransitionExecutionState({
    historyId,
    shop,
    expectedExecutionStates: [
      OPERATION_LIFECYCLE_STATES.PLANNED,
      OPERATION_LIFECYCLE_STATES.QUEUED,
      OPERATION_LIFECYCLE_STATES.SCHEDULED_QUEUED,
      OPERATION_LIFECYCLE_STATES.WAITING_FOR_SHOPIFY_SLOT,
      OPERATION_LIFECYCLE_STATES.SUSPENDED,
    ],
    nextExecutionState: OPERATION_LIFECYCLE_STATES.EXECUTING,
    batchPatch: mergeBatch(existing?.batch, {
      executionWorker: WORKER_NAME,
      executionStartedAt: new Date().toISOString(),
      suspension: null,
      ...batchPatch,
    }),
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
  const existing = await findHistoryBatch(historyId, shop);

  const updated = await casTransitionExecutionState({
    historyId,
    shop,
    expectedExecutionStates: [
      OPERATION_LIFECYCLE_STATES.EXECUTING,
      OPERATION_LIFECYCLE_STATES.WAITING_FOR_SHOPIFY_SLOT,
      OPERATION_LIFECYCLE_STATES.PLANNED,
      OPERATION_LIFECYCLE_STATES.QUEUED,
    ],
    nextExecutionState: OPERATION_LIFECYCLE_STATES.COMPLETED,
    nextStatus: "completed",
    batchPatch: mergeBatch(existing?.batch, {
      completedReason: "NO_MORE_FROZEN_TARGETS",
      completedEmptyBatchId: batchId || null,
      completedAt: new Date().toISOString(),
      hasMore: false,
    }),
    extraData: {
      completedAt: new Date(),
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
  return countRemainingSnapshotItems({ snapshotSetId, shop, cursorTargetKey });
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

  const latest = await findHistoryBatch(historyId, shop);

  if (
    typeof latest?.batch?.lastProductId === "string" &&
    latest.batch.lastProductId.trim()
  ) {
    return latest.batch.lastProductId;
  }

  return null;
}

async function isFrozenCursorExhausted({ snapshotSetId, shop, cursorOrdinal }) {
  const maxTargetKey = await findMaxSnapshotTargetKey({ snapshotSetId, shop });
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
  const existing = await findHistoryBatch(historyId, shop);

  const updated = await casTransitionExecutionState({
    historyId,
    shop,
    expectedExecutionStates: [
      OPERATION_LIFECYCLE_STATES.EXECUTING,
      OPERATION_LIFECYCLE_STATES.QUEUED,
      OPERATION_LIFECYCLE_STATES.WAITING_FOR_SHOPIFY_SLOT,
      OPERATION_LIFECYCLE_STATES.SCHEDULED_QUEUED,
    ],
    nextExecutionState: OPERATION_LIFECYCLE_STATES.WAITING_FOR_SHOPIFY_SLOT,
    batchPatch: mergeBatch(existing?.batch, {
      waitingForShopifySlot: true,
      waitingForShopifySlotAt: new Date().toISOString(),
      shopifySlotRetryDelayMs: delayMs,
      currentShopifyBulkOperation: currentBulkOperation || null,
    }),
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
  const existing = await findHistoryBatch(historyId, shop);

  const updated = await casMarkFailedNonTerminal({
    historyId,
    shop,
    failureStage,
    failureMessage: error?.message || String(error),
    batchPatch: mergeBatch(existing?.batch, {
      failedAt: new Date().toISOString(),
      failureStage,
      failureMessage: error?.message || String(error),
      failureStack:
        process.env.NODE_ENV === "production" ? undefined : error?.stack,
    }),
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
      jobId: `bulk-edit-execute:${shop}:${historyId}:${executionId}:waiting-shopify-slot`,
      attempts: 6,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { age: 86400, count: 1000 },
      removeOnFail: { age: 604800, count: 5000 },
    },
  );
}

async function processBulkEditExecuteJob(job) {
  const payload = assertJobPayload(job);
  const { historyId, snapshotSetId, shop, executionId, source } = payload;

  let lock = null;
  let executeLeaseOwnerId = null;
  let executeLeaseHeartbeat = null;
  let executeLeaseHeartbeatLost = false;
  let bulkMutationSlotOwnerId = null;
  let bulkMutationSlotHeartbeat = null;
  let bulkMutationSlotAcquired = false;
  let bulkMutationSlotHeldForShopify = false;

  try {
    await job.updateProgress({ stage: "loading_history", pct: 5 });
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
          jobId: `bulk-edit-execute:${shop}:${historyId}:${executionId}:shopify-slot`,
          attempts: 6,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: { age: 86400, count: 1000 },
          removeOnFail: { age: 604800, count: 5000 },
        },
      );

      return toWorkerOperationStatusDto({
        success: true,
        requeued: true,
        reason: "WRITE_CATALOG_LOCK_BUSY",
        delayMs,
      });
    }
    await job.updateProgress({ stage: "acquired_shop_lock", pct: 20 });

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
        {
          delay: delayMs,
          jobId: `bulk-edit-execute:${shop}:${historyId}:${executionId}:execute-lease`,
          attempts: 6,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: { age: 86400, count: 1000 },
          removeOnFail: { age: 604800, count: 5000 },
        },
      );
      return toWorkerOperationStatusDto({
        success: true,
        requeued: true,
        reason: "BULK_EDIT_EXECUTE_LEASE_BUSY",
        delayMs,
      });
    }

    executeLeaseHeartbeat = setInterval(() => {
      heartbeatOperationLease({
        shop,
        namespace: "BULK_EDIT_EXECUTE",
        resourceId: String(historyId),
        ownerId: executeLeaseOwnerId,
      }).catch((error) => {
        executeLeaseHeartbeatLost = true;
        logger.error("Bulk edit execute lease heartbeat failed", {
          worker: WORKER_NAME,
          queue: OPERATION_QUEUE_NAMES.BULK_EDIT_EXECUTE,
          shop,
          historyId,
          message: error?.message || String(error),
          stack: error?.stack,
        });
      });
    }, LEASE_HEARTBEAT_INTERVAL_MS);

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

    if (executeLeaseHeartbeatLost) {
      const error = new Error("BULK_EDIT_EXECUTE_LEASE_HEARTBEAT_LOST");
      error.retryable = true;
      throw error;
    }
    const session = await buildSessionForShop(shop);

    const client = new shopify.api.clients.Graphql({ session });
    await job.updateProgress({ stage: "preparing_batch", pct: 45 });

    const preparationService = new BulkEditExecutionPreparationService(session);

    const mutationService = new ShopifyBulkMutationService(session, client);

    const preparedBatch = await preparationService.prepareNextExecutionBatch({
      historyId,
      executionId,
    });
    if (executeLeaseHeartbeatLost) {
      const error = new Error("BULK_EDIT_EXECUTE_LEASE_HEARTBEAT_LOST");
      error.retryable = true;
      throw error;
    }
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

      return toWorkerOperationStatusDto({
        success: true,
        completed: true,
        reason: "NO_MORE_FROZEN_TARGETS",
        historyId,
      });
    }
    await job.updateProgress({ stage: "submitting_bulk_mutation", pct: 70 });
    if (executeLeaseHeartbeatLost) {
      const error = new Error("BULK_EDIT_EXECUTE_LEASE_HEARTBEAT_LOST");
      error.retryable = true;
      throw error;
    }
    await assertExecuteLeaseActive({
      shop,
      historyId,
      leaseOwnerId: executeLeaseOwnerId,
    });
    const executionMirrorState = await assertMirrorSafeForBulkExecution(shop, { historyId });
    if (
      String(history.targetMirrorBatchId || "")
      !== String(executionMirrorState.activeMirrorBatchId || "")
    ) {
      const error = new Error("PREVIEW_MIRROR_BATCH_STALE");
      error.nonRetryable = true;
      throw error;
    }
    runBulkEditPreflight({
      command: {
        confirmBroadTarget: history.batch?.confirmBroadTarget === true,
        criticalConfirmationText: history.batch?.criticalConfirmationText || null,
        scheduledAt: history.scheduledAt || null,
      },
      store: executionMirrorState,
      rules: history.rules,
      targetCount: history.targetSnapshotCount,
      subscription: authoritativeSubscription,
      requirePreview: false,
    });

    bulkMutationSlotOwnerId = buildLeaseOwnerId("shopify-bulk-mutation-slot");
    const bulkMutationSlot = await acquireShopifyBulkMutationSlot({
      shop,
      ownerId: bulkMutationSlotOwnerId,
    });
    if (!bulkMutationSlot?.acquired) {
      const delayMs = DEFAULT_REQUEUE_DELAY_MS;
      await addBulkEditExecuteJob(
        {
          historyId,
          shop,
          executionId,
          source: `${source}:bulk_mutation_slot_occupied`,
        },
        {
          delay: delayMs,
          jobId: `bulk-edit-execute:${shop}:${historyId}:${executionId}:bulk-mutation-slot`,
          attempts: 6,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: { age: 86400, count: 1000 },
          removeOnFail: { age: 604800, count: 5000 },
        },
      );
      return toWorkerOperationStatusDto({
        success: true,
        requeued: true,
        reason: "BULK_MUTATION_SLOT_OCCUPIED",
        delayMs,
      });
    }
    bulkMutationSlotAcquired = true;
    bulkMutationSlotHeartbeat = setInterval(() => {
      heartbeatOperationLease({
        shop,
        namespace: SHOPIFY_BULK_MUTATION_SLOT,
        resourceId: shopifyBulkMutationSlotResourceId(shop),
        ownerId: bulkMutationSlotOwnerId,
        ttlMs: SHOPIFY_BULK_MUTATION_SLOT_TTL_MS,
      }).catch(() => {});
    }, 60_000);

    let submission;
    try {
      submission = await executeWithShopifyCircuit(shop, () =>
        mutationService.submitProductSetBulkMutation({
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
        }));
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        const delayMs = suspensionDelayMs(error);
        const suspended = await suspendBulkEditForShopifyOutage({
          historyId,
          shop,
          error,
        });
        if (suspended.count !== 1) {
          throw new Error("BULK_EDIT_SUSPENSION_TRANSITION_REJECTED");
        }
        await addBulkEditExecuteJob(
          {
            historyId,
            shop,
            executionId,
            source: `${source}:shopify_unavailable_resume`,
          },
          {
            delay: delayMs,
            jobId: `bulk-edit-execute:${shop}:${historyId}:${executionId}:shopify-resume:${error.retryAfter.getTime()}`,
          },
        );
        return toWorkerOperationStatusDto({
          success: true,
          suspended: true,
          reason: "SHOPIFY_UNAVAILABLE",
          resumeAfter: error.retryAfter.toISOString(),
          delayMs,
        });
      }
      if (error?.submittedToShopify && error?.bulkOperationId) {
        bulkMutationSlotHeldForShopify = true;
        await casTransitionExecutionState({
          historyId,
          shop,
          expectedExecutionStates: [OPERATION_LIFECYCLE_STATES.EXECUTING],
          nextExecutionState: OPERATION_LIFECYCLE_STATES.RECONCILE_SUBMITTED,
          batchPatch: {
            shopifyBulkOperationId: error.bulkOperationId,
            reconcileReason: "SUBMITTED_BUT_LOCAL_PERSIST_FAILED",
            reconcileAt: new Date().toISOString(),
          },
        }).catch(() => {});
        throw Object.assign(
          new Error("BULK_EDIT_RECONCILE_SUBMITTED_AFTER_SHOPIFY_ACCEPTED"),
          { nonRetryable: true },
        );
      }
      throw error;
    }

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

      return toWorkerOperationStatusDto({
        success: true,
        submitted: false,
        waitingForShopifySlot: true,
        requeued: true,
        delayMs,
      });
    }
    await job.updateProgress({ stage: "submitted", pct: 100 });
    bulkMutationSlotHeldForShopify = true;

    return toWorkerOperationStatusDto({
      success: true,
      submitted: true,
      historyId,
      bulkOperationId: submission.bulkOperationId,
      batchId: submission.batchId,
      batchTargetCount: submission.batchTargetCount,
      hasMore: submission.hasMore,
      message: "Shopify bulk mutation submitted. Waiting for webhook/result ingestion.",
    });
  } catch (error) {
    const nonFailureErrors = new Set([
      "STALE_EXECUTION_JOB",
      "OPERATION_CANCEL_REQUESTED",
      "SHOPIFY_BULK_OPERATION_ALREADY_SUBMITTED",
    ]);

    const message = error?.message || String(error);

    if ([...nonFailureErrors].some((code) => message.includes(code))) {
      return toWorkerOperationStatusDto({
        success: true,
        ignored: true,
        alreadySubmitted: message.includes("SHOPIFY_BULK_OPERATION_ALREADY_SUBMITTED"),
        reason: message,
      });
    }

    const shouldTerminalFail = !isRetryableExecuteError(error) || willExhaustRetryFromProcessor(job);
    if (shouldTerminalFail) {
      try {
        await markFailed({
          historyId,
          shop,
          error,
        });
      } catch (markFailedError) {
        logger.error("markFailed failed while handling execute worker error", {
          worker: WORKER_NAME,
          queue: OPERATION_QUEUE_NAMES.BULK_EDIT_EXECUTE,
          historyId,
          shop,
          originalError: error?.message || String(error),
          markFailedError: markFailedError?.message || String(markFailedError),
          markFailedStack: markFailedError?.stack,
        });
      }
    } else {
      await upsertOperationStageProgress({
        shop,
        operationType: "BULK_EDIT",
        operationId: historyId,
        stageKey: "EXECUTING",
        stageStatus: "RETRYABLE_FAILURE",
        detail: { message: error?.message || String(error) },
      }).catch(() => {});
    }

    throw error;
  } finally {
    if (bulkMutationSlotHeartbeat) {
      clearInterval(bulkMutationSlotHeartbeat);
    }
    if (bulkMutationSlotAcquired && !bulkMutationSlotHeldForShopify) {
      await releaseShopifyBulkMutationSlot(shop).catch(() => {});
    }
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
    lockDuration: Number(process.env.BULK_EDIT_EXECUTE_LOCK_DURATION_MS || 600000),
    stalledInterval: Number(process.env.BULK_EDIT_EXECUTE_STALLED_INTERVAL_MS || 60000),
    maxStalledCount: Number(process.env.BULK_EDIT_EXECUTE_MAX_STALLED_COUNT || 1),
    limiter: {
      max: Number.isFinite(WORKER_LIMIT_MAX) ? WORKER_LIMIT_MAX : 5,
      duration: Number.isFinite(WORKER_LIMIT_DURATION_MS) ? WORKER_LIMIT_DURATION_MS : 1000,
    },
  },
);

const bulkEditExecuteQueueEvents = new QueueEvents(
  OPERATION_QUEUE_NAMES.BULK_EDIT_EXECUTE,
  { connection: createRedisConnection() },
);
bulkEditExecuteQueueEvents.on("failed", ({ jobId, failedReason }) => {
  logger.error("Bulk edit execute queue event failed", {
    queue: OPERATION_QUEUE_NAMES.BULK_EDIT_EXECUTE,
    jobId,
    failedReason,
  });
});
bulkEditExecuteQueueEvents.on("stalled", ({ jobId }) => {
  logger.warn("Bulk edit execute queue event stalled", {
    queue: OPERATION_QUEUE_NAMES.BULK_EDIT_EXECUTE,
    jobId,
  });
});

bulkEditExecuteWorker.on("completed", (job, result) => {
  logger.info("Bulk edit execute worker completed", {
    worker: WORKER_NAME,
    queue: OPERATION_QUEUE_NAMES.BULK_EDIT_EXECUTE,
    jobId: job.id,
    historyId: job.data?.historyId,
    shop: job.data?.shop,
    success: Boolean(result?.success),
    submitted: Boolean(result?.submitted),
    bulkOperationId: result?.bulkOperationId || null,
    batchId: result?.batchId || null,
    batchTargetCount: result?.batchTargetCount || null,
    hasMore: result?.hasMore ?? null,
    requeued: Boolean(result?.requeued),
    reason: result?.reason || null,
  });
});

bulkEditExecuteWorker.on("failed", (job, error) => {
  const maxAttempts = Number(job?.opts?.attempts || 1);
  const attemptsMade = Number(job?.attemptsMade || 0);
  if (attemptsMade >= maxAttempts) {
    void bulkEditExecuteDlqQueue.add(
      "bulk-edit-execute-dlq",
      {
        originalQueue: OPERATION_QUEUE_NAMES.BULK_EDIT_EXECUTE,
        originalJobId: job?.id,
        originalJobName: job?.name,
        data: job?.data,
        failedReason: error?.message || String(error),
        stack: error?.stack,
        failedAt: new Date().toISOString(),
      },
      {
        jobId: `dlq:${OPERATION_QUEUE_NAMES.BULK_EDIT_EXECUTE}:${job?.id}`,
        removeOnComplete: { age: 604800, count: 5000 },
      },
    ).catch((dlqErr) => {
      logger.error("Bulk edit execute DLQ enqueue failed", {
        worker: WORKER_NAME,
        queue: OPERATION_QUEUE_NAMES.BULK_EDIT_EXECUTE,
        originalJobId: job?.id,
        message: dlqErr?.message || String(dlqErr),
        stack: dlqErr?.stack,
      });
    });
  }

  logger.error("Bulk edit execute worker failed", {
    worker: WORKER_NAME,
    queue: OPERATION_QUEUE_NAMES.BULK_EDIT_EXECUTE,
    jobId: job?.id,
    historyId: job?.data?.historyId,
    shop: job?.data?.shop,
    attemptsMade: job?.attemptsMade,
    maxAttempts: job?.opts?.attempts,
    message: error?.message || String(error),
    stack: error?.stack,
  });
});

bulkEditExecuteWorker.on("error", (error) => {
  logger.error("Bulk edit execute worker runtime error", {
    worker: WORKER_NAME,
    queue: OPERATION_QUEUE_NAMES.BULK_EDIT_EXECUTE,
    message: error?.message || String(error),
    stack: error?.stack,
  });
});

export function startBulkEditExecuteWorker() {
  if (!startBulkEditExecuteWorker.started && !bulkEditExecuteWorker.isRunning()) {
    startBulkEditExecuteWorker.started = true;
    bulkEditExecuteWorker.run();
    logger.info("Bulk edit execute worker started", {
      worker: WORKER_NAME,
      queue: OPERATION_QUEUE_NAMES.BULK_EDIT_EXECUTE,
      concurrency: Number.isFinite(WORKER_CONCURRENCY) ? WORKER_CONCURRENCY : 2,
    });
  }

  return bulkEditExecuteWorker;
}
startBulkEditExecuteWorker.started = false;

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("Closing bulk edit execute worker", {
    worker: WORKER_NAME,
    queue: OPERATION_QUEUE_NAMES.BULK_EDIT_EXECUTE,
    signal,
  });

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("BULK_EDIT_EXECUTE_WORKER_CLOSE_TIMEOUT")), 25_000));

  try {
    await Promise.race([
      (async () => {
        await bulkEditExecuteWorker.close();
        await bulkEditExecuteQueueEvents.close();
      })(),
      timeout,
    ]);
  } catch (err) {
    logger.error("Bulk edit execute worker shutdown failed", {
      worker: WORKER_NAME,
      queue: OPERATION_QUEUE_NAMES.BULK_EDIT_EXECUTE,
      message: err?.message || String(err),
      stack: err?.stack,
    });
    process.exitCode = 1;
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

export default bulkEditExecuteWorker;
