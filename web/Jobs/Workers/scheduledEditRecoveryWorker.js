import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { scheduledEditQueue } from "../Queues/scheduledEditQueue.js";
import { db } from "../../repositories/repositoryDb.js";
import logger from "../../utils/loggerUtils.js";
import { logWorkerError } from "../../utils/errorLogUtils.js";
import { joinSafeJobId } from "../../utils/jobQueueUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../../services/operationLifecycleStateMachine.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../../utils/normalizedStateUtils.js";
import {
  dispatchPendingEnqueueIntents,
  ENQUEUE_QUEUE_KEYS,
} from "../../services/operationEnqueueIntentService.js";
import {
  acquireRedisLock,
  releaseRedisLock,
} from "../../utils/redisLockUtils.js";
import { enqueueScheduledEditRecoveryTick } from "../../queues/adapters/workerSchedulerQueueAdapter.js";

const QUEUE_NAME = "scheduled-edit-recovery";
const POLL_INTERVAL_MS = 60_000;
const LIMIT = 100;
const LEADER_LOCK_KEY = "leader:scheduled-edit-recovery:scheduler";
const LEADER_LOCK_TTL_MS = 45_000;

async function requeuePendingScheduledEdits() {
  const now = new Date();
  const rows = await db.editHistory.findMany({
    where: {
      editType: "Scheduled edit",
      scheduledAt: { gt: now },
      statusNormalized: normalizeEditHistoryStatus("pending"),
      executionState: OPERATION_LIFECYCLE_STATES.SCHEDULED_PENDING_QUEUE,
    },
    select: {
      id: true,
      shop: true,
      scheduledAt: true,
    },
    orderBy: { scheduledAt: "asc" },
    take: LIMIT,
  });

  let recovered = 0;
  for (const row of rows) {
    const delay = Math.max(new Date(row.scheduledAt).getTime() - Date.now(), 0);
    // eslint-disable-next-line no-await-in-loop
    await scheduledEditQueue.add(
      "scheduled-task",
      { historyId: row.id, shop: row.shop },
      {
        delay,
        jobId: joinSafeJobId(
          "scheduled-edit-recovery-dispatch",
          row.shop,
          row.id,
          new Date(row.scheduledAt).toISOString(),
        ),
      },
    );
    // eslint-disable-next-line no-await-in-loop
    await db.editHistory.updateMany({
      where: {
        id: row.id,
        shop: row.shop,
        statusNormalized: normalizeEditHistoryStatus("pending"),
        executionState: OPERATION_LIFECYCLE_STATES.SCHEDULED_PENDING_QUEUE,
      },
      data: {
        executionState: OPERATION_LIFECYCLE_STATES.SCHEDULED_QUEUED,
        executionStateNormalized: normalizeEditHistoryExecutionState(
          OPERATION_LIFECYCLE_STATES.SCHEDULED_QUEUED,
        ),
      },
    });
    recovered += 1;
  }

  if (recovered > 0) {
    logger.info("Recovered scheduled edits pending queue", {
      worker: "scheduledEditRecoveryWorker",
      recovered,
    });
  }
}

async function runRecoveryTick() {
  try {
    await requeuePendingScheduledEdits();
    const shops = await db.operationEnqueueIntent.findMany({
      where: {
        status: "PENDING",
        queueRoutingKey: ENQUEUE_QUEUE_KEYS.SCHEDULED_EDIT,
      },
      select: { shop: true },
      distinct: ["shop"],
      take: LIMIT,
    });
    for (const row of shops) {
      // eslint-disable-next-line no-await-in-loop
      await dispatchPendingEnqueueIntents({
        shop: row.shop,
        queueRoutingKey: ENQUEUE_QUEUE_KEYS.SCHEDULED_EDIT,
        limit: LIMIT,
      });
    }
  } catch (error) {
    await logWorkerError({
      shop: "unknown",
      err: error,
      source: "scheduledEditRecoveryWorker",
    });
  }
}

export const scheduledEditRecoveryWorker = new Worker(
  QUEUE_NAME,
  async () => runRecoveryTick(),
  { connection, concurrency: 1 },
);

async function registerRepeatableTick() {
  const leaderLock = await acquireRedisLock({
    connection,
    key: LEADER_LOCK_KEY,
    ttlMs: LEADER_LOCK_TTL_MS,
  });
  if (!leaderLock.acquired) return;

  try {
    await enqueueScheduledEditRecoveryTick(POLL_INTERVAL_MS);
  } finally {
    await releaseRedisLock({
      connection,
      key: leaderLock.key,
      token: leaderLock.token,
    }).catch(() => {});
  }
}

await registerRepeatableTick();

export default scheduledEditRecoveryWorker;
