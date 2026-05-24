import { Worker, Queue } from "bullmq";
import { connection } from "../../config/redis.js";
import shopify from "../../shopify.js";
import { prisma } from "../../config/database.js";
import { BulkEditResultIngestionService } from "../../services/bulkEdit/BulkEditResultIngestionService.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../../services/operationLifecycleStateMachine.js";
import { getSession } from "../../utils/sessionHandler.js";
import { upsertOperationStageProgress } from "../../services/operationStageProgressService.js";

const QUEUE_NAME = process.env.BULK_EDIT_RESULT_INGEST_QUEUE || "bulk-edit-result-ingest";
const VERIFY_QUEUE_NAME = process.env.BULK_EDIT_VERIFICATION_QUEUE || "bulk-edit-verification";
const MAX_RESULT_URL_RETRIES = Number.parseInt(
  process.env.BULK_EDIT_RESULT_URL_MAX_RETRIES || "4",
  10,
);

const verificationQueue = new Queue(VERIFY_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 6,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: { age: 7 * 24 * 3600, count: 2000 },
    removeOnFail: { age: 30 * 24 * 3600, count: 10000 },
  },
});

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
  return (
    jobData.bulkOperationId
    || jobData.admin_graphql_api_id
    || jobData.id
    || null
  );
}

function resolveResultUrl(jobData = {}) {
  return jobData.resultUrl || jobData.url || jobData.partialDataUrl || null;
}

async function fetchBulkOperationResultUrl({ shop, bulkOperationId }) {
  const session = await getSession(shop);
  if (!session?.shop || session.shop !== shop) {
    throw new Error("Shop session not available for result ingestion");
  }

  const client = new shopify.api.clients.Graphql({ session });
  const response = await client.query({
    data: {
      query: BULK_OPERATION_RESULT_QUERY,
      variables: { id: bulkOperationId },
    },
  });

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
  const byColumn = await prisma.editHistory.findFirst({
    where: { shop, bulkOperationId },
    select: {
      id: true,
      shop: true,
      executionIdentity: true,
      batch: true,
      executionState: true,
      executionStateNormalized: true,
    },
  });

  if (byColumn) return byColumn;

  return prisma.editHistory.findFirst({
    where: {
      shop,
      batch: {
        path: ["shopifyBulkOperation", "id"],
        equals: String(bulkOperationId),
      },
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
  await verificationQueue.add(
    "bulk-edit-verification",
    {
      historyId,
      shop,
      executionId,
      source: "bulk_edit_result_ingest",
    },
    {
      jobId: `bulk-edit-verification:${historyId}:${executionId || "none"}`,
    },
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

  const history = await findHistoryByBulkOperation({ shop, bulkOperationId });
  if (!history) {
    return {
      skipped: true,
      reason: "edit_history_not_found_for_bulk_operation",
      shop,
      bulkOperationId,
    };
  }

  const executionId = executionIdFromJob || history.executionIdentity || null;
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
    await enqueueVerification({
      historyId: history.id,
      shop,
      executionId,
    });
    return {
      skipped: true,
      reason: "already_ingested",
      historyId: history.id,
      shop,
      bulkOperationId,
    };
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
  const status = webhookStatus || fetched.status;
  const resultUrl =
    resolveResultUrl(job.data || {})
    || fetched.url
    || fetched.partialDataUrl
    || null;

  if (status && ["FAILED", "CANCELED", "CANCELLED", "EXPIRED"].includes(status)) {
    const failedUpdate = await prisma.editHistory.updateMany({
      where: { id: history.id, shop },
      data: {
        status: "failed",
        statusNormalized: normalizeEditHistoryStatus("failed"),
        executionState: OPERATION_LIFECYCLE_STATES.FAILED,
        executionStateNormalized: normalizeEditHistoryExecutionState(
          OPERATION_LIFECYCLE_STATES.FAILED,
        ),
        failureStage: "SHOPIFY_BULK_OPERATION",
        completedAt: new Date(),
        batch: {
          ...(history.batch && typeof history.batch === "object" ? history.batch : {}),
          shopifyBulkOperation: {
            ...(history.batch?.shopifyBulkOperation || {}),
            id: bulkOperationId,
            status,
            failedAt: new Date().toISOString(),
          },
        },
      },
    });
    if (failedUpdate.count !== 1) {
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
    return {
      success: true,
      deferred: true,
      historyId: history.id,
      shop,
      bulkOperationId,
      status,
    };
  }

  if (!resultUrl) {
    const attemptNumber = Number(job.attemptsMade || 0) + 1;
    const exhausted = attemptNumber >= MAX_RESULT_URL_RETRIES;

    if (exhausted) {
      await prisma.editHistory.updateMany({
        where: { id: history.id, shop },
        data: {
          status: "failed",
          statusNormalized: normalizeEditHistoryStatus("failed"),
          executionState: OPERATION_LIFECYCLE_STATES.FAILED,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            OPERATION_LIFECYCLE_STATES.FAILED,
          ),
          failureStage: "RESULT_INGESTION_URL_EXPIRED",
          completedAt: new Date(),
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
      });
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

    throw new Error("RESULT_URL_MISSING_OR_EXPIRED_RETRYABLE");
  }

  const updated = await prisma.editHistory.updateMany({
    where: { id: history.id, shop },
    data: {
      executionState: OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
      executionStateNormalized: normalizeEditHistoryExecutionState(
        OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
      ),
    },
  });
  if (updated.count !== 1) {
    throw new Error("EDIT_HISTORY_UPDATE_FAILED_SET_INGESTING");
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
    const isResultUrlError =
      message.includes("Failed to download Shopify result JSONL: 403")
      || message.includes("Failed to download Shopify result JSONL: 410")
      || message.includes("RESULT_URL_");

    if (!isResultUrlError) {
      throw error;
    }

    const attemptNumber = Number(job.attemptsMade || 0) + 1;
    const exhausted = attemptNumber >= MAX_RESULT_URL_RETRIES;
    if (!exhausted) {
      throw new Error("RESULT_URL_EXPIRED_RETRYABLE");
    }

    await prisma.editHistory.updateMany({
      where: { id: history.id, shop },
      data: {
        status: "failed",
        statusNormalized: normalizeEditHistoryStatus("failed"),
        executionState: OPERATION_LIFECYCLE_STATES.FAILED,
        executionStateNormalized: normalizeEditHistoryExecutionState(
          OPERATION_LIFECYCLE_STATES.FAILED,
        ),
        failureStage: "RESULT_INGESTION_URL_EXPIRED",
        completedAt: new Date(),
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
    });
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

  await enqueueVerification({
    historyId: history.id,
    shop,
    executionId,
  });

  return {
    success: true,
    historyId: history.id,
    shop,
    bulkOperationId,
    ingested: result,
    verificationEnqueued: true,
  };
}

const bulkEditResultIngestWorker = new Worker(
  QUEUE_NAME,
  processBulkEditResultIngest,
  {
    connection,
    concurrency: 2,
  },
);

export default bulkEditResultIngestWorker;
