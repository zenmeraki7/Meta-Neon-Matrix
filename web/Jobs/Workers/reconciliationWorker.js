import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import logger from "../../utils/loggerUtils.js";
import { db } from "../../repositories/repositoryDb.js";
import { addShopSyncJob } from "../Queues/shopSyncJob.js";
import { RECONCILIATION_QUEUE_NAME } from "../Queues/reconciliationJob.js";
import {
  assessMirrorHealth,
  repairMirror,
} from "../../services/mirrorHealthService.js";
import { checkExpiringResultFiles } from "../../services/bulkEdit/bulkSubmissionResultExpiryService.js";
import { addbulkEditResultIngestJob } from "../Queues/bulkEditResultIngestJob.js";

const RECONCILIATION_STALE_HOURS = Number(process.env.RECONCILIATION_STALE_HOURS || 23);
const STALE_SIGNAL_THRESHOLD_MS = Number(
  process.env.RECONCILIATION_STALE_SIGNAL_THRESHOLD_MS || 30 * 60 * 1000,
);
const STALE_SIGNAL_COUNT_THRESHOLD = Number(
  process.env.RECONCILIATION_STALE_SIGNAL_COUNT_THRESHOLD || 3,
);

function isReconciliationDue(lastFullSyncAt) {
  if (!lastFullSyncAt) return true;
  const thresholdMs = RECONCILIATION_STALE_HOURS * 60 * 60 * 1000;
  return Date.now() - new Date(lastFullSyncAt).getTime() >= thresholdMs;
}

async function processReconciliationJob(job) {
  const shop = String(job?.data?.shop || "").trim();
  if (!shop) {
    throw new Error("reconciliation job requires shop");
  }

  const resultFileExpiry = await checkExpiringResultFiles({
    db,
    shop,
    enqueueResultIngest: addbulkEditResultIngestJob,
    logger,
  });

  const store = await db.store.findUnique({
    where: {
      shopUrl: shop,
    },
    select: {
      shopUrl: true,
      isProductSyncing: true,
      lastFullSyncAt: true,
    },
  });
  const health = await assessMirrorHealth(shop);
  if (health.repairRequired || ["UNSAFE", "REPAIR_REQUIRED"].includes(health.state)) {
    await repairMirror(shop);
  }

  let queued = 0;
  let skipped = 0;
  const enqueuedShops = new Set();

  if (!store || store.isProductSyncing || !isReconciliationDue(store.lastFullSyncAt)) {
    skipped += 1;
  } else {
    try {
      await addShopSyncJob({
        shop,
        syncType: "product",
        reason: "RECONCILIATION_CRON",
      });
      enqueuedShops.add(shop);
      queued += 1;
    } catch (error) {
      skipped += 1;
      logger.error("Failed to enqueue reconciliation shop sync", {
        worker: "reconciliationWorker",
        queue: RECONCILIATION_QUEUE_NAME,
        shop,
        message: error?.message || String(error),
      });
    }
  }

  const stalePendingSignals = await db.mirrorReconcileSignal.count({
    where: {
      shop,
      status: "pending",
      latestEventAt: { lt: new Date(Date.now() - STALE_SIGNAL_THRESHOLD_MS) },
    },
  });

  if (
    stalePendingSignals >= STALE_SIGNAL_COUNT_THRESHOLD
    && !enqueuedShops.has(shop)
  ) {
    try {
      await addShopSyncJob({
        shop,
        syncType: "product",
        reason: "STALE_RECONCILE_SIGNALS",
      });
      enqueuedShops.add(shop);
      queued += 1;
    } catch (error) {
      skipped += 1;
      logger.error("Failed to enqueue stale reconcile signal shop sync", {
        worker: "reconciliationWorker",
        queue: RECONCILIATION_QUEUE_NAME,
        shop,
        pendingCount: stalePendingSignals,
        message: error?.message || String(error),
      });
    }
  }

  return { queued, skipped, shop, resultFileExpiry };
}

export const reconciliationWorker = new Worker(
  RECONCILIATION_QUEUE_NAME,
  processReconciliationJob,
  {
    connection,
    concurrency: 1,
  },
);

reconciliationWorker.on("completed", (job, result) => {
  logger.info("Reconciliation scheduler tick completed", {
    worker: "reconciliationWorker",
    queue: RECONCILIATION_QUEUE_NAME,
    jobId: job?.id,
    result,
  });
});

reconciliationWorker.on("failed", (job, error) => {
  logger.error("Reconciliation scheduler tick failed", {
    worker: "reconciliationWorker",
    queue: RECONCILIATION_QUEUE_NAME,
    jobId: job?.id,
    message: error?.message || String(error),
  });
});

export default reconciliationWorker;
