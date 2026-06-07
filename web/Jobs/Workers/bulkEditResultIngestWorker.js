import { QueueEvents, UnrecoverableError, Worker } from "bullmq";
import { connection, createRedisConnection } from "../../config/redis.js";
import shopify from "../../shopify.js";
import { db } from "../../repositories/repositoryDb.js";
import logger from "../../utils/loggerUtils.js";
import { BulkEditResultIngestionService } from "../../services/bulkEdit/BulkEditResultIngestionService.js";
import {
  markBulkSubmissionProcessed,
  recordBulkSubmissionResultUrl,
} from "../../services/bulkEdit/bulkSubmissionResultExpiryService.js";
import { OPERATION_LIFECYCLE_STATES } from "../../services/operationLifecycleStateMachine.js";
import { transitionOperation } from "../../services/operationTransitionService.js";
import { getSession } from "../../utils/sessionHandler.js";
import { upsertOperationStageProgress } from "../../services/operationStageProgressService.js";
import { enqueueBulkEditVerification } from "../../queues/adapters/bulkEditVerificationQueueAdapter.js";
import {
  acquireOperationLease,
  assertOperationLeaseOwnership,
  buildLeaseOwnerId,
  heartbeatOperationLease,
  releaseOperationLease,
} from "../../services/operationLeaseService.js";
import { bulkEditResultIngestDlqQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";

const QUEUE_NAME = process.env.BULK_EDIT_RESULT_INGEST_QUEUE || "bulk-edit-result-ingest";
const MAX_RESULT_URL_RETRIES = Number.parseInt(
  process.env.BULK_EDIT_RESULT_URL_MAX_RETRIES || "4",
  10,
);
const WORKER_NAME = "bulkEditResultIngestWorker";
const INGEST_LEASE_NAMESPACE = "BULK_EDIT_RESULT_INGEST";
const INGEST_LEASE_HEARTBEAT_MS = Number(
  process.env.BULK_EDIT_RESULT_INGEST_LEASE_HEARTBEAT_MS || 20_000,
);

const BULK_OPERATION_RESULT_QUERY = `#graphql
  query BulkOperationResult($id: ID!) {
    node(id: $id) {
      ... on BulkOperation {
        id
        status
        url
        partialDataUrl
        createdAt
        completedAt
      }
    }
  }
`;

function resolveBulkOperationId(jobData = {}) {
  return jobData.bulkOperationId || null;
}

function resolveResultUrl(jobData = {}) {
  return jobData.resultUrl || jobData.url || jobData.partialDataUrl || null;
}

async function fetchBulkOperationResultUrl({ shop, bulkOperationId }) {
  const normalize = (s) => String(s || "").toLowerCase().replace(/\/$/, "");
  const session = await getSession(shop);
  if (
    !session?.accessToken
    || !session?.shop
    || normalize(session.shop) !== normalize(shop)
  ) {
    throw new UnrecoverableError("SHOP_SESSION_NOT_AVAILABLE");
  }

  const client = new shopify.api.clients.Graphql({ session });
  let response;
  try {
    response = await client.query({
      data: {
        query: BULK_OPERATION_RESULT_QUERY,
        variables: { id: bulkOperationId },
      },
    });
  } catch (error) {
    const status = Number(
      error?.response?.status || error?.statusCode || error?.status || 0,
    );
    if (status === 401 || status === 403) {
      throw new UnrecoverableError("SHOPIFY_AUTH_REVOKED");
    }
    throw error;
  }
  const errors = response?.body?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const message = errors[0]?.message || "unknown";
    const err = new Error(`SHOPIFY_GRAPHQL_ERROR:${message}`);
    if (isRetryableShopifyGraphqlMessage(message)) {
      err.retryable = true;
    }
    throw err;
  }

  const node = response?.body?.data?.node || null;
  return {
    status: String(node?.status || "").toUpperCase(),
    url: node?.url || null,
    partialDataUrl: node?.partialDataUrl || null,
  };
}

function mergeBatch(existingBatch, patch) {
  return {
    ...(existingBatch && typeof existingBatch === "object" ? existingBatch : {}),
    ...patch,
  };
}

async function findHistoryByBulkOperation({ shop, bulkOperationId }) {
  return db.editHistory.findFirst({
    where: {
      shop,
      OR: [
        { bulkOperationId },
        {
          batch: {
            path: ["shopifyBulkOperation", "id"],
            equals: String(bulkOperationId),
          },
        },
      ],
    },
    select: {
      id: true,
      shop: true,
      executionIdentity: true,
      batch: true,
      executionState: true,
      executionStateNormalized: true,
      cancelRequestedAt: true,
    },
  });
}

async function enqueueVerification({ historyId, shop, executionId }) {
  await enqueueBulkEditVerification(
    {
      historyId,
      shop,
      executionId,
      source: "bulk_edit_result_ingest",
    },
    {
      jobId: `bulk-edit-verify:${shop}:${historyId}:${executionId || "default"}`,
    },
  );
}

function getMaxAttempts(job) {
  return Number(job?.opts?.attempts || 1);
}

function hasExhaustedRetry(job) {
  return Number(job?.attemptsMade || 0) >= getMaxAttempts(job);
}

function willExhaustUrlRetry(job) {
  const maxAttempts = Math.min(getMaxAttempts(job), MAX_RESULT_URL_RETRIES);
  return Number(job?.attemptsMade || 0) + 1 >= maxAttempts;
}

function isRetryableShopifyGraphqlMessage(message) {
  const lower = String(message || "").toLowerCase();
  return (
    lower.includes("throttled")
    || lower.includes("timeout")
    || lower.includes("internal error")
  );
}

async function processBulkEditResultIngest(job) {
  const shop = job.data?.shop;
  const bulkOperationId = resolveBulkOperationId(job.data || {});
  const webhookStatus = String(job.data?.status || "").toUpperCase();
  const executionIdFromJob = job.data?.executionId || null;

  if (!shop || !bulkOperationId) {
    throw new Error("bulk edit result ingest job requires shop and bulkOperationId");
  }

  let history = await findHistoryByBulkOperation({ shop, bulkOperationId });
  if (!history) {
    const source = String(job.data?.source || "").toLowerCase();
    if (source.includes("webhook") || source.includes("polling")) {
      const error = new Error("EDIT_HISTORY_NOT_FOUND_RETRYABLE");
      error.retryable = true;
      throw error;
    }
    return {
      skipped: true,
      reason: "edit_history_not_found_for_bulk_operation",
      shop,
      bulkOperationId,
    };
  }

  let executionId = executionIdFromJob || history.executionIdentity || null;
  let ingestLeaseOwnerId = null;
  let ingestLeaseHeartbeat = null;
  let ingestLeaseLost = false;

  const cleanupLease = async () => {
    if (ingestLeaseHeartbeat) {
      clearInterval(ingestLeaseHeartbeat);
      ingestLeaseHeartbeat = null;
    }
    if (ingestLeaseOwnerId) {
      await releaseOperationLease({
        shop,
        namespace: INGEST_LEASE_NAMESPACE,
        resourceId: String(history.id),
        ownerId: ingestLeaseOwnerId,
      }).catch((error) => {
        logger.error("Bulk edit result ingest lease release failed", {
          worker: WORKER_NAME,
          queue: QUEUE_NAME,
          shop,
          historyId: history.id,
          bulkOperationId,
          message: error?.message || String(error),
          stack: error?.stack,
        });
      });
      ingestLeaseOwnerId = null;
    }
  };

  try {
    ingestLeaseOwnerId = buildLeaseOwnerId("bulk-edit-result-ingest");
    const ingestLease = await acquireOperationLease({
      shop,
      namespace: INGEST_LEASE_NAMESPACE,
      resourceId: String(history.id),
      ownerId: ingestLeaseOwnerId,
    });
    if (!ingestLease?.acquired) {
      const err = new Error("BULK_EDIT_RESULT_INGEST_LEASE_BUSY");
      err.retryable = true;
      throw err;
    }
    ingestLeaseHeartbeat = setInterval(() => {
      void heartbeatOperationLease({
        shop,
        namespace: INGEST_LEASE_NAMESPACE,
        resourceId: String(history.id),
        ownerId: ingestLeaseOwnerId,
      }).then((ok) => {
        if (!ok) {
          ingestLeaseLost = true;
        }
      }).catch((error) => {
        ingestLeaseLost = true;
        logger.error("Bulk edit result ingest lease heartbeat failed", {
          worker: WORKER_NAME,
          queue: QUEUE_NAME,
          shop,
          historyId: history.id,
          bulkOperationId,
          message: error?.message || String(error),
          stack: error?.stack,
        });
      });
    }, INGEST_LEASE_HEARTBEAT_MS);

    await assertOperationLeaseOwnership({
      shop,
      namespace: INGEST_LEASE_NAMESPACE,
      resourceId: String(history.id),
      ownerId: ingestLeaseOwnerId,
    });

    if (ingestLeaseLost) {
      const err = new Error("BULK_EDIT_RESULT_INGEST_LEASE_HEARTBEAT_LOST");
      err.retryable = true;
      throw err;
    }

    const leasedHistory = await findHistoryByBulkOperation({ shop, bulkOperationId });
    if (!leasedHistory) {
      return {
        skipped: true,
        reason: "edit_history_not_found_after_lease",
        historyId: history.id,
        shop,
        bulkOperationId,
      };
    }
    history = leasedHistory;
    executionId = executionIdFromJob || history.executionIdentity || null;
    if (
      executionIdFromJob
      && history.executionIdentity
      && executionIdFromJob !== history.executionIdentity
    ) {
      return {
        skipped: true,
        reason: "stale_execution_identity",
        historyId: history.id,
        shop,
        bulkOperationId,
      };
    }

  if (history.cancelRequestedAt) {
    await transitionOperation({
      shop,
      operationId: history.id,
      expectedExecutionStates: [
        OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING,
        OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
        OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
      ],
      expectedFenceToken: Number(history.batch?.executeLeaseFencingToken || 0),
      nextExecutionState: OPERATION_LIFECYCLE_STATES.CANCELLED,
      transitionKey: "bulk_result_ingest_cancel_requested",
      actor: { type: "worker", id: WORKER_NAME },
      reasonCode: "CANCEL_REQUESTED_DURING_RESULT_INGESTION",
      metadata: { bulkOperationId },
      db: db,
    }).catch(() => {});
    return {
      skipped: true,
      reason: "operation_cancel_requested",
      historyId: history.id,
      shop,
      bulkOperationId,
    };
  }
  if (
    [
      OPERATION_LIFECYCLE_STATES.CANCELLED,
      OPERATION_LIFECYCLE_STATES.COMPLETED,
      OPERATION_LIFECYCLE_STATES.PARTIAL_FAILED,
    ].includes(history.executionState)
  ) {
    return {
      skipped: true,
      reason: "operation_already_terminal",
      historyId: history.id,
      shop,
      bulkOperationId,
    };
  }

    const alreadyIngested = Boolean(history.batch?.resultIngestion?.ingestedAt);
    if (alreadyIngested) {
      try {
        await enqueueVerification({
          historyId: history.id,
          shop,
          executionId,
        });
      } catch (error) {
        logger.error("Verification enqueue failed for already-ingested result", {
          worker: WORKER_NAME,
          queue: QUEUE_NAME,
          shop,
          historyId: history.id,
          bulkOperationId,
          message: error?.message || String(error),
          stack: error?.stack,
        });
        const enqueueError = new Error("VERIFICATION_ENQUEUE_FAILED_AFTER_INGESTION");
        enqueueError.retryable = true;
        throw enqueueError;
      }
    return {
      skipped: true,
      reason: "already_ingested",
      historyId: history.id,
      shop,
      bulkOperationId,
    };
  }

    const ingesting = await transitionOperation({
      shop,
      operationId: history.id,
      expectedExecutionStates: [
        OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
        OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING,
        OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
      ],
      expectedFenceToken: Number(history.batch?.executeLeaseFencingToken || 0),
      nextExecutionState: OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
      transitionKey: "bulk_result_ingest_started",
      actor: { type: "worker", id: WORKER_NAME },
      reasonCode: "RESULT_INGESTION_STARTED",
      metadata: { bulkOperationId, webhookStatus },
      db,
    });
    if (!ingesting?.ok) {
      throw new Error("EDIT_HISTORY_UPDATE_FAILED_MARK_INGESTING_RESULTS");
    }

    await upsertOperationStageProgress({
    shop,
    operationType: "BULK_EDIT",
    operationId: history.id,
    executionId,
    stageKey: "RESULT_INGESTION",
    stageStatus: "RUNNING",
  });

    const fetched = await fetchBulkOperationResultUrl({ shop, bulkOperationId });
    const status = String(fetched.status || "").toUpperCase();
  const resultUrl =
    fetched.url
    || fetched.partialDataUrl
    || resolveResultUrl(job.data || {})
    || null;

  if (resultUrl) {
    await recordBulkSubmissionResultUrl({
      db,
      shop,
      bulkOperationId,
      resultUrl,
    });
  }

  if (status && ["FAILED", "CANCELED", "CANCELLED", "EXPIRED"].includes(status)) {
    const cancelled = ["CANCELED", "CANCELLED"].includes(status);
    const terminalStatus = cancelled ? "cancelled" : "failed";
    const terminalState = cancelled
      ? OPERATION_LIFECYCLE_STATES.CANCELLED
      : OPERATION_LIFECYCLE_STATES.FAILED;
    const failureStage = cancelled
      ? "SHOPIFY_BULK_OPERATION_CANCELLED"
      : "SHOPIFY_BULK_OPERATION";
    const failedUpdate = await transitionOperation({
      shop,
      operationId: history.id,
      expectedExecutionStates: [
        OPERATION_LIFECYCLE_STATES.QUEUED,
        OPERATION_LIFECYCLE_STATES.WAITING_FOR_SHOPIFY_SLOT,
        OPERATION_LIFECYCLE_STATES.EXECUTING,
        OPERATION_LIFECYCLE_STATES.SHOPIFY_BULK_SUBMITTED,
        OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING,
        OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
        OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
      ],
      expectedFenceToken: Number(history.batch?.executeLeaseFencingToken || 0),
      nextExecutionState: terminalState,
      transitionKey: "bulk_result_ingest_shopify_terminal_failure",
      actor: { type: "worker", id: "bulkEditResultIngestWorker" },
      reasonCode: cancelled ? "SHOPIFY_BULK_CANCELLED" : "SHOPIFY_BULK_FAILED",
      metadata: { bulkOperationId, shopifyStatus: status, webhookStatus },
      dataPatch: {
        failureStage,
        batch: {
          ...(history.batch && typeof history.batch === "object" ? history.batch : {}),
          shopifyBulkOperation: {
            ...(history.batch?.shopifyBulkOperation || {}),
            id: bulkOperationId,
            status,
            webhookStatus: webhookStatus || null,
            failedAt: new Date().toISOString(),
          },
        },
      },
      db: db,
    });
    if (!failedUpdate?.ok) {
      throw new Error("EDIT_HISTORY_UPDATE_FAILED_SET_SHOPIFY_FAILURE");
    }
    return {
      success: true,
      historyId: history.id,
      shop,
      bulkOperationId,
      failed: true,
      status,
    };
  }

    if (status && status !== "COMPLETED" && status !== "COMPLETED_WITH_ERRORS") {
      await transitionOperation({
        shop,
        operationId: history.id,
        expectedExecutionStates: [
          OPERATION_LIFECYCLE_STATES.SHOPIFY_BULK_SUBMITTED,
          OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING,
          OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
        ],
        expectedFenceToken: Number(history.batch?.executeLeaseFencingToken || 0),
        nextExecutionState: OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING,
        transitionKey: "bulk_result_ingest_shopify_not_completed",
        actor: { type: "worker", id: WORKER_NAME },
        reasonCode: "SHOPIFY_BULK_OPERATION_NOT_COMPLETED",
        metadata: { bulkOperationId, status, webhookStatus },
        dataPatch: {
          batch: mergeBatch(history.batch, {
            shopifyBulkOperation: {
              ...(history.batch?.shopifyBulkOperation || {}),
              id: bulkOperationId,
              status,
              webhookStatus: webhookStatus || null,
              lastCheckedAt: new Date().toISOString(),
            },
          }),
        },
        db,
      }).catch(() => {});
      const err = new Error(`BULK_OPERATION_NOT_YET_COMPLETED:${status}`);
      err.retryable = true;
      throw err;
    }

  if (!resultUrl) {
    const attemptNumber = Number(job.attemptsMade || 0) + 1;
    const exhausted = willExhaustUrlRetry(job);

    if (exhausted) {
      const failedForMissingUrl = await transitionOperation({
        shop,
        operationId: history.id,
        expectedExecutionStates: [
          OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING,
          OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
          OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
        ],
        expectedFenceToken: Number(history.batch?.executeLeaseFencingToken || 0),
        nextExecutionState: OPERATION_LIFECYCLE_STATES.FAILED,
        transitionKey: "bulk_result_ingest_url_missing",
        actor: { type: "worker", id: "bulkEditResultIngestWorker" },
        reasonCode: "RESULT_INGESTION_URL_MISSING_OR_EXPIRED",
        metadata: { bulkOperationId, status, attemptNumber },
        dataPatch: {
          failureStage: "RESULT_INGESTION_URL_EXPIRED",
          batch: mergeBatch(history.batch, {
            resultIngestionFailure: {
              code: "RESULT_URL_MISSING_OR_EXPIRED",
              attemptNumber,
              exhausted: true,
              status,
              bulkOperationId,
              failedAt: new Date().toISOString(),
            },
          }),
        },
        db: db,
      });
      if (!failedForMissingUrl?.ok) {
        throw new Error("EDIT_HISTORY_UPDATE_FAILED_RESULT_URL_MISSING_TERMINAL");
      }
      return {
        success: false,
        failed: true,
        reason: "RESULT_URL_MISSING_OR_EXPIRED",
        historyId: history.id,
        shop,
        bulkOperationId,
        attemptNumber,
      };
    }

    const err = new Error("RESULT_URL_MISSING_OR_EXPIRED_RETRYABLE");
    err.retryable = true;
    throw err;
  }

  if (ingestLeaseLost) {
    const err = new Error("INGEST_LEASE_LOST_BEFORE_INGESTION");
    err.retryable = true;
    throw err;
  }

  const service = new BulkEditResultIngestionService();
  let result;
  try {
    result = await service.ingestCompletedBulkOperation({
      shop,
      historyId: history.id,
      executionId,
      bulkOperationId,
      resultUrl,
      attempt: job.attemptsMade + 1,
      leaseOwnerId: ingestLeaseOwnerId,
    });
    await markBulkSubmissionProcessed({
      db,
      shop,
      bulkOperationId,
    });
    await upsertOperationStageProgress({
      shop,
      operationType: "BULK_EDIT",
      operationId: history.id,
      executionId,
      stageKey: "RESULT_INGESTION",
      stageStatus: "COMPLETED",
      counterA: Number(result?.successCount || 0),
      counterB: Number(result?.failureCount || 0),
      counterC: Number(result?.rowCount || 0),
      completed: true,
    });
  } catch (error) {
    const message = String(error?.message || "");
    const deterministicDataError =
      message.includes("MALFORMED_RESULT_JSONL_ROWS")
      || message.includes("UNMAPPED_RESULT_ROWS");
    if (deterministicDataError) {
      const failedForDataError = await transitionOperation({
        shop,
        operationId: history.id,
        expectedExecutionStates: [
          OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING,
          OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
          OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
        ],
        expectedFenceToken: Number(history.batch?.executeLeaseFencingToken || 0),
        nextExecutionState: OPERATION_LIFECYCLE_STATES.FAILED,
        transitionKey: "bulk_result_ingest_data_corruption",
        actor: { type: "worker", id: "bulkEditResultIngestWorker" },
        reasonCode: "RESULT_INGESTION_DATA_CORRUPTION",
        metadata: { bulkOperationId, message },
        dataPatch: {
          failureStage: "RESULT_INGESTION_DATA_CORRUPTION",
          batch: mergeBatch(history.batch, {
            resultIngestionFailure: {
              code: "RESULT_JSONL_DATA_CORRUPTION",
              bulkOperationId,
              failedAt: new Date().toISOString(),
              message,
            },
          }),
        },
        db: db,
      });
      if (!failedForDataError?.ok) {
        throw new Error("EDIT_HISTORY_UPDATE_FAILED_RESULT_JSONL_DATA_CORRUPTION_TERMINAL");
      }
      return {
        success: false,
        failed: true,
        reason: "RESULT_JSONL_DATA_CORRUPTION",
        historyId: history.id,
        shop,
        bulkOperationId,
      };
    }
    const isResultUrlError =
      message.includes("Failed to download Shopify result JSONL: 403")
      || message.includes("Failed to download Shopify result JSONL: 410")
      || message.includes("RESULT_URL_");

    if (!isResultUrlError) {
      throw error;
    }

    const attemptNumber = Number(job.attemptsMade || 0) + 1;
    const exhausted = willExhaustUrlRetry(job);
    if (!exhausted) {
      const err = new Error("RESULT_URL_EXPIRED_RETRYABLE");
      err.retryable = true;
      throw err;
    }

    const failedForExpiredUrl = await transitionOperation({
      shop,
      operationId: history.id,
      expectedExecutionStates: [
        OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING,
        OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
        OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
      ],
      expectedFenceToken: Number(history.batch?.executeLeaseFencingToken || 0),
      nextExecutionState: OPERATION_LIFECYCLE_STATES.FAILED,
      transitionKey: "bulk_result_ingest_url_expired",
      actor: { type: "worker", id: "bulkEditResultIngestWorker" },
      reasonCode: "RESULT_INGESTION_URL_EXPIRED",
      metadata: { bulkOperationId, attemptNumber, message },
      dataPatch: {
        failureStage: "RESULT_INGESTION_URL_EXPIRED",
        batch: mergeBatch(history.batch, {
          resultIngestionFailure: {
            code: "RESULT_URL_EXPIRED",
            attemptNumber,
            exhausted: true,
            bulkOperationId,
            failedAt: new Date().toISOString(),
            message,
          },
        }),
      },
      db: db,
    });
    if (!failedForExpiredUrl?.ok) {
      throw new Error("EDIT_HISTORY_UPDATE_FAILED_RESULT_URL_EXPIRED_TERMINAL");
    }
    return {
      success: false,
      failed: true,
      reason: "RESULT_URL_EXPIRED",
      historyId: history.id,
      shop,
      bulkOperationId,
      attemptNumber,
    };
  }

    if (ingestLeaseLost) {
      logger.warn("Ingest lease lost after ingestion completed", {
        worker: WORKER_NAME,
        queue: QUEUE_NAME,
        shop,
        historyId: history.id,
        bulkOperationId,
      });
      return {
        success: true,
        historyId: history.id,
        shop,
        bulkOperationId,
        ingested: result,
        verificationEnqueued: false,
        leaseLostAfterIngest: true,
      };
    }

    try {
      await enqueueVerification({
    historyId: history.id,
    shop,
    executionId,
      });
    } catch (error) {
      logger.error("Failed to enqueue bulk edit verification after ingestion", {
        worker: WORKER_NAME,
        queue: QUEUE_NAME,
        shop,
        historyId: history.id,
        bulkOperationId,
        message: error?.message || String(error),
        stack: error?.stack,
      });
      await upsertOperationStageProgress({
        shop,
        operationType: "BULK_EDIT",
        operationId: history.id,
        executionId,
        stageKey: "VERIFY",
        stageStatus: "QUEUE_FAILED",
        detail: { message: error?.message || String(error) },
      });
      const enqueueError = new Error("VERIFICATION_ENQUEUE_FAILED_AFTER_INGESTION");
      enqueueError.retryable = true;
      throw enqueueError;
    }

    return {
    success: true,
    historyId: history.id,
    shop,
    bulkOperationId,
    ingested: result,
    verificationEnqueued: true,
    };
  } finally {
    await cleanupLease();
  }
}

const bulkEditResultIngestWorker = new Worker(
  QUEUE_NAME,
  processBulkEditResultIngest,
  {
    connection,
    concurrency: Number(process.env.BULK_EDIT_RESULT_INGEST_CONCURRENCY || 2),
    limiter: {
      max: Number(process.env.BULK_EDIT_RESULT_INGEST_LIMIT_MAX || 5),
      duration: Number(process.env.BULK_EDIT_RESULT_INGEST_LIMIT_DURATION_MS || 1000),
    },
    lockDuration: Number(process.env.BULK_EDIT_RESULT_INGEST_LOCK_DURATION_MS || 600000),
    stalledInterval: Number(process.env.BULK_EDIT_RESULT_INGEST_STALLED_INTERVAL_MS || 60000),
    maxStalledCount: Number(process.env.BULK_EDIT_RESULT_INGEST_MAX_STALLED_COUNT || 1),
  },
);

const bulkEditResultIngestQueueEvents = new QueueEvents(QUEUE_NAME, {
  connection: createRedisConnection(),
});
bulkEditResultIngestQueueEvents.on("failed", ({ jobId, failedReason }) => {
  logger.error("Bulk edit result ingest queue event failed", {
    queue: QUEUE_NAME,
    jobId,
    failedReason,
  });
});
bulkEditResultIngestQueueEvents.on("stalled", ({ jobId }) => {
  logger.warn("Bulk edit result ingest queue event stalled", {
    queue: QUEUE_NAME,
    jobId,
  });
});

bulkEditResultIngestWorker.on("completed", (job, result) => {
  logger.info("Bulk edit result ingest worker completed", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    bulkOperationId: job?.data?.bulkOperationId,
    ingested: Boolean(result?.ingested),
    rowCount: result?.ingested?.rowCount ?? null,
    successCount: result?.ingested?.successCount ?? null,
    failureCount: result?.ingested?.failureCount ?? null,
    verificationEnqueued: Boolean(result?.verificationEnqueued),
    skipped: Boolean(result?.skipped),
    reason: result?.reason || null,
  });
});
bulkEditResultIngestWorker.on("failed", (job, err) => {
  if (hasExhaustedRetry(job) || err?.name === "UnrecoverableError") {
    void bulkEditResultIngestDlqQueue.add(
      "bulk-edit-result-ingest-dlq",
      {
        originalQueue: QUEUE_NAME,
        originalJobId: job?.id,
        originalJobName: job?.name,
        data: job?.data,
        failedReason: err?.message || String(err),
        stack: err?.stack,
        failedAt: new Date().toISOString(),
      },
      {
        jobId: `dlq:${QUEUE_NAME}:${job?.id}`,
        removeOnComplete: { age: 604800, count: 5000 },
      },
    ).catch((dlqErr) => {
      logger.error("Bulk edit result ingest DLQ enqueue failed", {
        worker: WORKER_NAME,
        queue: QUEUE_NAME,
        originalJobId: job?.id,
        message: dlqErr?.message || String(dlqErr),
        stack: dlqErr?.stack,
      });
    });
  }
  logger.error("Bulk edit result ingest worker failed", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    bulkOperationId: job?.data?.bulkOperationId,
    attemptsMade: job?.attemptsMade,
    maxAttempts: job?.opts?.attempts,
    message: err?.message,
    stack: err?.stack,
  });
});
bulkEditResultIngestWorker.on("error", (err) => {
  logger.error("Bulk edit result ingest worker runtime error", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    message: err?.message,
    stack: err?.stack,
  });
});
bulkEditResultIngestWorker.on("stalled", (jobId) => {
  logger.warn("Bulk edit result ingest worker stalled", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId,
  });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("Closing bulk edit result ingest worker", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    signal,
  });
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("BULK_EDIT_RESULT_INGEST_WORKER_CLOSE_TIMEOUT")), 25_000));
  try {
    await Promise.race([
      (async () => {
        await bulkEditResultIngestWorker.close();
        await bulkEditResultIngestQueueEvents.close();
      })(),
      timeout,
    ]);
  } catch (err) {
    logger.error("Bulk edit result ingest worker shutdown failed", {
      worker: WORKER_NAME,
      queue: QUEUE_NAME,
      message: err?.message || String(err),
      stack: err?.stack,
    });
    process.exitCode = 1;
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

export default bulkEditResultIngestWorker;
