import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import logger from "../../utils/loggerUtils.js";
import { logWorkerError } from "../../utils/errorLogUtils.js";
import { enqueueOperationEnqueueIntentRecoveryTick } from "../../queues/adapters/workerSchedulerQueueAdapter.js";
import {
  dispatchPendingEnqueueIntents,
} from "../../services/operationEnqueueIntentService.js";
import { recoverLegacyPendingScheduledExportRuns } from "../../services/scheduledExportExecutionService.js";
import { recoverLegacyPendingRecurringEditRuns } from "../../services/recurringEditExecutionService.js";
import {
  acquireRedisLock,
  releaseRedisLock,
} from "../../utils/redisLockUtils.js";

const QUEUE_NAME = "operation-enqueue-intent-recovery";
const POLL_INTERVAL_MS = 60_000;
const LIMIT = 100;
const LEADER_LOCK_KEY = "leader:operation-enqueue-intent-recovery:scheduler";
const LEADER_LOCK_TTL_MS = 45_000;

async function runTick() {
  try {
    await recoverLegacyPendingScheduledExportRuns({ limit: LIMIT }).catch(() => {});
    await recoverLegacyPendingRecurringEditRuns({ limit: LIMIT }).catch(() => {});

    const scheduledDispatched = await dispatchPendingEnqueueIntents({ limit: LIMIT })
      .then((result) => Number(result.dispatched || 0));
    const pipelineDispatched = 0;
    const exportRunDispatched = 0;
    const editRunDispatched = 0;

    if (scheduledDispatched > 0 || pipelineDispatched > 0 || exportRunDispatched > 0 || editRunDispatched > 0) {
      logger.info("Operation enqueue intent recovery dispatched pending intents", {
        worker: "operationEnqueueIntentRecoveryWorker",
        scheduledDispatched,
        pipelineDispatched,
        exportRunDispatched,
        editRunDispatched,
      });
    }
  } catch (error) {
    await logWorkerError({
      shop: "unknown",
      err: error,
      source: "operationEnqueueIntentRecoveryWorker",
    });
    throw error;
  }
}

export const operationEnqueueIntentRecoveryWorker = new Worker(
  QUEUE_NAME,
  async () => runTick(),
  { connection, concurrency: 1 },
);
operationEnqueueIntentRecoveryWorker.on("error", (error) => {
  logger.error("Operation enqueue intent recovery worker error", {
    error: error?.message,
    stack: error?.stack,
  });
});

async function registerRepeatableTick() {
  const leaderLock = await acquireRedisLock({
    connection,
    key: LEADER_LOCK_KEY,
    ttlMs: LEADER_LOCK_TTL_MS,
  });
  if (!leaderLock.acquired) return;

  try {
    await enqueueOperationEnqueueIntentRecoveryTick(POLL_INTERVAL_MS);
  } finally {
    await releaseRedisLock({
      connection,
      key: leaderLock.key,
      token: leaderLock.token,
    }).catch(() => {});
  }
}

await registerRepeatableTick();

export default operationEnqueueIntentRecoveryWorker;
