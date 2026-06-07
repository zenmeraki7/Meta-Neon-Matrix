import { Queue, Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { db } from "../../repositories/repositoryDb.js";
import { enqueueBulkEditVerification } from "../../queues/adapters/bulkEditVerificationQueueAdapter.js";
import { OPERATION_LIFECYCLE_STATES } from "../../services/operationLifecycleStateMachine.js";
import { guardedEditHistoryUpdate } from "../../services/operationTransitionGuards.js";
import { upsertOperationStageProgress } from "../../services/operationStageProgressService.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../../utils/normalizedStateUtils.js";
import logger from "../../utils/loggerUtils.js";

const QUEUE_NAME = "verification-resume";
const STUCK_AFTER_MS = 10 * 60 * 1000;
const VERIFICATION_TIMEOUT_MS =
  Math.max(1, Number.parseInt(process.env.VERIFICATION_TIMEOUT_MINUTES || "30", 10)) * 60 * 1000;
const HARD_TIMEOUT_MS = VERIFICATION_TIMEOUT_MS * 2;
const REPEAT_EVERY_MS = 60 * 1000;
const PAGE_LIMIT = 100;

export const verificationResumeQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { age: 24 * 3600, count: 500 },
    removeOnFail: { age: 7 * 24 * 3600, count: 2_000 },
  },
});

async function resumeStuckVerifications() {
  const now = Date.now();
  const cutoff = new Date(now - STUCK_AFTER_MS);
  const hardTimeoutCutoff = new Date(now - HARD_TIMEOUT_MS);
  const stuck = await db.editHistory.findMany({
    where: {
      OR: [
        {
          executionState: OPERATION_LIFECYCLE_STATES.VERIFYING,
          OR: [
            { updatedAt: { lt: cutoff } },
            { startedAt: { lt: hardTimeoutCutoff } },
          ],
        },
        {
          executionState: OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
          updatedAt: { lt: cutoff },
        },
      ],
    },
    select: {
      id: true,
      shop: true,
      executionIdentity: true,
      executionState: true,
      verificationCursor: true,
      startedAt: true,
    },
    orderBy: { updatedAt: "asc" },
    take: PAGE_LIMIT,
  });

  let enqueued = 0;
  let timedOut = 0;
  for (const history of stuck) {
    if (
      history.executionState === OPERATION_LIFECYCLE_STATES.VERIFYING
      && history.startedAt
      && new Date(history.startedAt).getTime() < hardTimeoutCutoff.getTime()
    ) {
      // eslint-disable-next-line no-await-in-loop
      const transitioned = await guardedEditHistoryUpdate({
        id: history.id,
        shop: history.shop,
        expectedExecutionStates: [OPERATION_LIFECYCLE_STATES.VERIFYING],
        extraWhere: { startedAt: { lt: hardTimeoutCutoff } },
        data: {
          status: "failed",
          statusNormalized: normalizeEditHistoryStatus("failed"),
          executionState: OPERATION_LIFECYCLE_STATES.VERIFICATION_TIMEOUT,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            OPERATION_LIFECYCLE_STATES.VERIFICATION_TIMEOUT,
          ),
          completedAt: new Date(),
          error: {
            code: "VERIFICATION_TIMEOUT",
            message: `Verification exceeded hard timeout of ${HARD_TIMEOUT_MS}ms`,
          },
        },
      });
      if (transitioned) {
        timedOut += 1;
        // eslint-disable-next-line no-await-in-loop
        await upsertOperationStageProgress({
          shop: history.shop,
          operationType: "BULK_EDIT",
          operationId: history.id,
          executionId: history.executionIdentity || null,
          stageKey: "VERIFICATION",
          stageStatus: "FAILED",
          detail: {
            reason: "VERIFICATION_TIMEOUT",
            timeoutMs: HARD_TIMEOUT_MS,
            source: "verification_resume_worker",
          },
        });
      }
      continue;
    }

    const bucket = Math.floor(Date.now() / STUCK_AFTER_MS);
    // eslint-disable-next-line no-await-in-loop
    await enqueueBulkEditVerification(
      {
        historyId: history.id,
        shop: history.shop,
        executionId: history.executionIdentity || null,
        source: "verification_resume_worker",
      },
      {
        delay: 1_000,
        jobId: `bulk-edit-verify-resume:${history.shop}:${history.id}:${history.verificationCursor}:${bucket}`,
      },
    );
    enqueued += 1;
  }

  return { scanned: stuck.length, enqueued, timedOut };
}

export const verificationResumeWorker = new Worker(
  QUEUE_NAME,
  resumeStuckVerifications,
  { connection, concurrency: 1 },
);

verificationResumeWorker.on("completed", (job, result) => {
  logger.info("Stuck verification recovery completed", {
    worker: "verificationResumeWorker",
    jobId: job?.id,
    result,
  });
});

verificationResumeWorker.on("failed", (job, error) => {
  logger.error("Stuck verification recovery failed", {
    worker: "verificationResumeWorker",
    jobId: job?.id,
    message: error?.message || String(error),
  });
});

void verificationResumeQueue.add(
  "resume-stuck-verifications",
  {},
  {
    jobId: "resume-stuck-verifications",
    repeat: { every: REPEAT_EVERY_MS },
  },
).catch((error) => {
  logger.error("Failed to register stuck verification recovery tick", {
    worker: "verificationResumeWorker",
    message: error?.message || String(error),
  });
});

export default verificationResumeWorker;
