import { Queue, Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { prisma } from "../../config/database.js";
import logger from "../../utils/loggerUtils.js";
import { logWorkerError } from "../../utils/errorLogUtils.js";
import {
  dispatchPendingEnqueueIntents,
  ENQUEUE_QUEUE_KEYS,
} from "../../services/operationEnqueueIntentService.js";
import {
  acquireRedisLock,
  releaseRedisLock,
} from "../../utils/redisLockUtils.js";

const QUEUE_NAME = "operation-enqueue-intent-recovery";
const POLL_INTERVAL_MS = 60_000;
const LIMIT = 100;
const LEADER_LOCK_KEY = "leader:operation-enqueue-intent-recovery:scheduler";
const LEADER_LOCK_TTL_MS = 45_000;

export const operationEnqueueIntentRecoveryQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 2,
    removeOnComplete: { age: 3600, count: 200 },
    removeOnFail: { age: 24 * 3600, count: 500 },
  },
});

async function runIntentDispatch(queueKey) {
  const shops = await prisma.operationEnqueueIntent.findMany({
    where: {
      status: "PENDING",
      queueKey,
      runAt: { lte: new Date() },
    },
    select: { shop: true },
    distinct: ["shop"],
    take: LIMIT,
  });

  let dispatched = 0;
  for (const row of shops) {
    // eslint-disable-next-line no-await-in-loop
    const result = await dispatchPendingEnqueueIntents({
      shop: row.shop,
      queueKey,
      limit: LIMIT,
    });
    dispatched += Number(result.dispatched || 0);
  }
  return dispatched;
}

async function runTick() {
  try {
    const [scheduledDispatched, pipelineDispatched] = await Promise.all([
      runIntentDispatch(ENQUEUE_QUEUE_KEYS.SCHEDULED_EDIT),
      runIntentDispatch(ENQUEUE_QUEUE_KEYS.BULK_EDIT_PIPELINE),
    ]);

    if (scheduledDispatched > 0 || pipelineDispatched > 0) {
      logger.info("Operation enqueue intent recovery dispatched pending intents", {
        worker: "operationEnqueueIntentRecoveryWorker",
        scheduledDispatched,
        pipelineDispatched,
      });
    }
  } catch (error) {
    await logWorkerError({
      shop: "unknown",
      err: error,
      source: "operationEnqueueIntentRecoveryWorker",
    });
  }
}

export const operationEnqueueIntentRecoveryWorker = new Worker(
  QUEUE_NAME,
  async () => runTick(),
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
    await operationEnqueueIntentRecoveryQueue.add(
      "operation-enqueue-intent-recovery-tick",
      {},
      {
        jobId: "operation-enqueue-intent-recovery-tick",
        repeat: { every: POLL_INTERVAL_MS },
      },
    );
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
