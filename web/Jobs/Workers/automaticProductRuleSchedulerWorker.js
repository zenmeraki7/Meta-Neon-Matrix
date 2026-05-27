import { Queue, Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import logger from "../../utils/loggerUtils.js";
import { scheduleDueAutomaticProductRuleRuns } from "../../services/automaticProductRuleExecutionService.js";
import {
  acquireRedisLock,
  releaseRedisLock,
} from "../../utils/redisLockUtils.js";

const QUEUE_NAME = "automatic-product-rule-scheduler";
const POLL_INTERVAL_MS = 60_000;
const LEADER_LOCK_KEY = "leader:automatic-product-rule-scheduler:register";
const LEADER_LOCK_TTL_MS = 45_000;

export const automaticProductRuleSchedulerQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 2,
    removeOnComplete: { age: 3600, count: 200 },
    removeOnFail: { age: 24 * 3600, count: 500 },
  },
});

async function runSchedulerTick() {
  try {
    const result = await scheduleDueAutomaticProductRuleRuns();
    if (result?.scheduled || result?.skipped) {
      logger.info("Automatic product rule scheduler tick completed", result);
    }
  } catch (error) {
    logger.error("Automatic product rule scheduler tick failed", {
      error: error.message,
      stack: error.stack,
    });
  }
}

export const automaticProductRuleSchedulerWorker = new Worker(
  QUEUE_NAME,
  async () => runSchedulerTick(),
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
    await automaticProductRuleSchedulerQueue.add(
      "automatic-product-rule-scheduler-tick",
      {},
      {
        jobId: "automatic-product-rule-scheduler-tick",
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

export default automaticProductRuleSchedulerWorker;
