import { UnrecoverableError, Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { db } from "../../repositories/repositoryDb.js";
import { addBulkEditExecuteJob } from "../Queues/bulkEditExecuteJob.js";
import { OPERATION_LIFECYCLE_STATES } from "../../services/operationLifecycleStateMachine.js";
import { normalizeEditHistoryExecutionState } from "../../utils/normalizedStateUtils.js";
import {
  getJobAttempt,
  isRetryExhausted,
  recordRetryExhausted,
} from "../../utils/workerTelemetry.js";
import logger from "../../utils/loggerUtils.js";
import { logWorkerError } from "../../utils/errorLogUtils.js";
import { bulkImportExecuteDlqQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";

const QUEUE_NAME = process.env.IMPORT_EDIT_EXECUTE_QUEUE || "import-edit-execute";
const DLQ_NAME = process.env.IMPORT_EDIT_EXECUTE_DLQ_QUEUE || "import-edit-execute-dlq";
const WORKER_NAME = "bulkImportExecuteWorker";
const TERMINAL_STATES = new Set([
  OPERATION_LIFECYCLE_STATES.COMPLETED,
  OPERATION_LIFECYCLE_STATES.PARTIAL_FAILED,
  OPERATION_LIFECYCLE_STATES.FAILED,
  OPERATION_LIFECYCLE_STATES.CANCELLED,
]);

const bulkImportExecuteWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { historyId, shop, executionId } = job.data || {};
    if (!historyId || !shop || !executionId) {
      throw new UnrecoverableError(
        "bulk import execute job requires historyId, shop, and executionId",
      );
    }

    try {
      const history = await db.editHistory.findFirst({
        where: { id: historyId, shop },
        select: {
          executionIdentity: true,
          executionState: true,
          cancelRequestedAt: true,
        },
      });
      if (!history) {
        throw new UnrecoverableError("IMPORT_HISTORY_NOT_FOUND");
      }
      if (history.executionIdentity && history.executionIdentity !== executionId) {
        throw new UnrecoverableError("STALE_IMPORT_EXECUTION_JOB");
      }
      if (history.cancelRequestedAt || history.executionState === OPERATION_LIFECYCLE_STATES.CANCELLED) {
        return { skipped: true, reason: "import_cancelled", historyId };
      }
      if (TERMINAL_STATES.has(history.executionState)) {
        return {
          skipped: true,
          reason: `already_terminal:${history.executionState}`,
          historyId,
        };
      }

      if (history.executionState === OPERATION_LIFECYCLE_STATES.TARGET_FROZEN) {
        const movedToPlanned = await db.editHistory.updateMany({
          where: {
            id: historyId,
            shop,
            ...(history.executionIdentity ? { executionIdentity: executionId } : {}),
            executionState: OPERATION_LIFECYCLE_STATES.TARGET_FROZEN,
          },
          data: {
            executionState: OPERATION_LIFECYCLE_STATES.PLANNED,
            executionStateNormalized: normalizeEditHistoryExecutionState(
              OPERATION_LIFECYCLE_STATES.PLANNED,
            ),
          },
        });
        if (movedToPlanned.count !== 1) {
          throw new Error("IMPORT_EXECUTE_HANDOFF_TRANSITION_CONFLICT");
        }
      } else if (history.executionState !== OPERATION_LIFECYCLE_STATES.PLANNED) {
        return {
          skipped: true,
          reason: `execute_already_advanced:${history.executionState}`,
          historyId,
        };
      }

      await addBulkEditExecuteJob({
        historyId,
        shop,
        source: "csv_import_execute_handoff",
        executionId,
      });

      return { success: true, historyId, executionId };
    } catch (error) {
      logger.error("Bulk import execute handoff failed", {
        worker: WORKER_NAME,
        queue: QUEUE_NAME,
        jobId: job.id,
        shop,
        historyId,
        executionId,
        attempt: getJobAttempt(job),
        message: error?.message,
      });
      await logWorkerError({
        shop,
        err: error,
        source: WORKER_NAME,
        metadata: {
          queue: QUEUE_NAME,
          worker: WORKER_NAME,
          jobId: job?.id || null,
          historyId,
          executionId,
          attempt: getJobAttempt(job),
        },
      });
      throw error;
    }
  },
  {
    connection,
    concurrency: Number(process.env.IMPORT_EDIT_EXECUTE_CONCURRENCY || 5),
    lockDuration: Number(process.env.IMPORT_EDIT_EXECUTE_LOCK_DURATION_MS || 60_000),
    stalledInterval: Number(process.env.IMPORT_EDIT_EXECUTE_STALLED_INTERVAL_MS || 30_000),
    maxStalledCount: Number(process.env.IMPORT_EDIT_EXECUTE_MAX_STALLED_COUNT || 1),
  },
);

bulkImportExecuteWorker.on("failed", (job, error) => {
  logger.error("Bulk import execute handoff job failed", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    historyId: job?.data?.historyId,
    executionId: job?.data?.executionId,
    attempt: getJobAttempt(job),
    message: error?.message,
  });
  if (isRetryExhausted(job) || error?.name === "UnrecoverableError") {
    void recordRetryExhausted({
      job,
      shop: job?.data?.shop,
      worker: WORKER_NAME,
      queue: QUEUE_NAME,
      entityType: "editHistory",
      entityId: job?.data?.historyId,
      executionId: job?.data?.executionId,
      message: "Bulk import execute handoff exhausted retries",
    }).catch(() => {});
    void bulkImportExecuteDlqQueue.add(
      DLQ_NAME,
      {
        originalJobId: job?.id,
        data: job?.data,
        failedReason: error?.message,
        stack: error?.stack,
        failedAt: new Date().toISOString(),
      },
      { jobId: `dlq:${QUEUE_NAME}:${job?.id}` },
    ).catch((dlqError) => {
      logger.error("Bulk import execute handoff DLQ enqueue failed", {
        worker: WORKER_NAME,
        jobId: job?.id,
        message: dlqError?.message,
      });
    });
  }
});

bulkImportExecuteWorker.on("completed", (job, result) => {
  logger.info("Bulk import execute handoff completed", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    historyId: job?.data?.historyId,
    skipped: Boolean(result?.skipped),
    reason: result?.reason || null,
  });
});

bulkImportExecuteWorker.on("stalled", (jobId) => {
  logger.warn("Bulk import execute handoff stalled", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId,
  });
});

bulkImportExecuteWorker.on("error", (error) => {
  logger.error("Bulk import execute handoff runtime error", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    message: error?.message,
    stack: error?.stack,
  });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await bulkImportExecuteWorker.close();
  } catch (error) {
    logger.error("Bulk import execute handoff shutdown failed", {
      worker: WORKER_NAME,
      signal,
      message: error?.message,
    });
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

export default bulkImportExecuteWorker;
