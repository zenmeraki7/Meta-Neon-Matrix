import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import logger from "../../utils/loggerUtils.js";
import { db } from "../../repositories/repositoryDb.js";
import { addShopSyncJob } from "../Queues/shopSyncJob.js";
import { RECONCILIATION_QUEUE_NAME } from "../Queues/reconciliationJob.js";

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

async function processReconciliationJob() {
  const stores = await db.store.findMany({
    where: {
      isUnInstalled: false,
    },
    select: {
      shopUrl: true,
      isProductSyncing: true,
      lastFullSyncAt: true,
    },
    orderBy: { shopUrl: "asc" },
  });

  let queued = 0;
  let skipped = 0;
  const enqueuedShops = new Set();

  for (const store of stores) {
    const shop = String(store?.shopUrl || "").trim();
    if (!shop) {
      skipped += 1;
      continue;
    }

    if (store.isProductSyncing || !isReconciliationDue(store.lastFullSyncAt)) {
      skipped += 1;
      continue;
    }

    try {
      // shop-sync queue enforces dedupe/fingerprints per shop+syncType+reason.
      // This is safe to call repeatedly across reconciliation ticks.
      // eslint-disable-next-line no-await-in-loop
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

  const stalePendingSignals = await db.mirrorReconcileSignal.groupBy({
    by: ["shop"],
    where: {
      status: "pending",
      latestEventAt: { lt: new Date(Date.now() - STALE_SIGNAL_THRESHOLD_MS) },
    },
    _count: { shop: true },
  });

  for (const row of stalePendingSignals) {
    const shop = String(row?.shop || "").trim();
    const pendingCount = Number(row?._count?.shop || 0);
    if (!shop || pendingCount < STALE_SIGNAL_COUNT_THRESHOLD) {
      continue;
    }
    if (enqueuedShops.has(shop)) {
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop
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
        pendingCount,
        message: error?.message || String(error),
      });
    }
  }

  return { queued, skipped, totalStores: stores.length };
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
