import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { db } from "../../repositories/repositoryDb.js";
import logger from "../../utils/loggerUtils.js";
import { logWorkerError } from "../../utils/errorLogUtils.js";
import { enqueueOperationEnqueueIntentRecoveryTick } from "../../queues/adapters/workerSchedulerQueueAdapter.js";
import {
  dispatchPendingEnqueueIntents,
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

async function runIntentDispatch({ shop }) {
  const result = await dispatchPendingEnqueueIntents({
    shop,
    limit: LIMIT,
  });
  return Number(result.dispatched || 0);
}

async function reconcileSubmittedProductSyncs(shop) {
  const result = await db.operationFingerprint.updateMany({
    where: {
      shop,
      operationType: "PRODUCT_SYNC",
      status: "RECONCILE_SUBMITTED",
      resourceType: "shopify_bulk_operation",
      resourceId: { not: null },
    },
    data: {
      status: "RUNNING",
      lastError: null,
      updatedAt: new Date(),
    },
  });
  return result.count;
}

async function runTick(job) {
  const shop = String(job?.data?.shop || "").trim();
  if (!shop) {
    throw new Error("operation enqueue intent recovery tick requires shop");
  }
  try {
    const [intentDispatched, productSyncsReconciled] = await Promise.all([
      runIntentDispatch({ shop }),
      reconcileSubmittedProductSyncs(shop),
    ]);

    if (intentDispatched > 0 || productSyncsReconciled > 0) {
      logger.info("Operation enqueue intent recovery dispatched pending intents", {
        worker: "operationEnqueueIntentRecoveryWorker",
        shop,
        intentDispatched,
        productSyncsReconciled,
      });
    }
  } catch (error) {
    await logWorkerError({
      shop,
      err: error,
      source: "operationEnqueueIntentRecoveryWorker",
    });
    throw error;
  }
}

export const operationEnqueueIntentRecoveryWorker = new Worker(
  QUEUE_NAME,
  async (job) => runTick(job),
  { connection, concurrency: 1 },
);
operationEnqueueIntentRecoveryWorker.on("error", (error) => {
  logger.error("Operation enqueue intent recovery worker error", {
    error: error?.message,
    stack: error?.stack,
  });
});

export async function registerOperationEnqueueIntentRecoveryTick({ shop }) {
  const scopedShop = String(shop || "").trim();
  if (!scopedShop) {
    throw new Error("operation enqueue intent recovery registration requires shop");
  }
  const leaderLock = await acquireRedisLock({
    connection,
    key: `${LEADER_LOCK_KEY}:${scopedShop}`,
    ttlMs: LEADER_LOCK_TTL_MS,
  });
  if (!leaderLock.acquired) return;

  try {
    await enqueueOperationEnqueueIntentRecoveryTick({
      shop: scopedShop,
      repeatEveryMs: POLL_INTERVAL_MS,
    });
  } finally {
    await releaseRedisLock({
      connection,
      key: leaderLock.key,
      token: leaderLock.token,
    }).catch(() => {});
  }
}

export default operationEnqueueIntentRecoveryWorker;
