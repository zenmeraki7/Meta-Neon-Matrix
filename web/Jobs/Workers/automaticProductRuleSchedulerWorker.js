import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import logger from "../../utils/loggerUtils.js";
import { scheduleDueAutomaticProductRuleRuns } from "../../services/automaticProductRuleExecutionService.js";
import {
  acquireRedisLock,
  releaseRedisLock,
} from "../../utils/redisLockUtils.js";

const QUEUE_NAME = "automatic-product-rule-scheduler";
const LEADER_LOCK_KEY = "leader:automatic-product-rule-scheduler:register";
const LEADER_LOCK_TTL_MS = 45_000;

async function runSchedulerTick(jobData = {}) {
  const shop = String(jobData?.shop || "").trim();
  if (!shop) {
    throw new Error("automatic product rule scheduler tick requires shop");
  }
  try {
    const result = await scheduleDueAutomaticProductRuleRuns({ shop });
    if (result?.scheduled || result?.skipped) {
      logger.info("Automatic product rule scheduler tick completed", result);
    }
  } catch (error) {
    logger.error("Automatic product rule scheduler tick failed", {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

export const automaticProductRuleSchedulerWorker = new Worker(
  QUEUE_NAME,
  async (job) => runSchedulerTick(job.data || {}),
  { connection, concurrency: 1 },
);
automaticProductRuleSchedulerWorker.on("error", (error) => {
  logger.error("Automatic product rule scheduler worker error", {
    error: error?.message,
    stack: error?.stack,
  });
});

export async function registerAutomaticProductRuleSchedulerTick({ shop, enqueueSchedulerTick, repeatEveryMs = 60_000 }) {
  const scopedShop = String(shop || "").trim();
  if (!scopedShop) {
    throw new Error("automatic product rule scheduler registration requires shop");
  }
  const leaderLock = await acquireRedisLock({
    connection,
    key: `${LEADER_LOCK_KEY}:${scopedShop}`,
    ttlMs: LEADER_LOCK_TTL_MS,
  });
  if (!leaderLock.acquired) return;

  try {
    await enqueueSchedulerTick({ shop: scopedShop, repeatEveryMs });
  } finally {
    await releaseRedisLock({
      connection,
      key: leaderLock.key,
      token: leaderLock.token,
    }).catch(() => {});
  }
}

export default automaticProductRuleSchedulerWorker;
