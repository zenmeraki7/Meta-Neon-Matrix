import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { prisma } from "../../config/database.js";
import logger from "../../utils/loggerUtils.js";
import { getSession } from "../../utils/sessionHandler.js";
import { getCurrentBulkOperationStatus } from "../../utils/bulkOperationHelper.js";
import { Services } from "../../services/productService/productFilterService.js";
import { CollectionService } from "../../services/collectionService/CollectionService.js";
import shopify from "../../shopify.js";
import {
  markCollectionReconciliationPending,
  markInventoryReconciliationPending,
  markRepairRequired,
  MIRROR_STALE_REASONS,
} from "../../services/mirrorHealthService.js";
import { recordMirrorAnomaly } from "../../services/mirrorAnomalyService.js";
import {
  acquireExclusiveShopWork,
  releaseExclusiveShopWork,
} from "../../services/shopWorkLeaseService.js";
import { getJobAttempt, isRetryExhausted, recordRetryExhausted } from "../../utils/workerTelemetry.js";

const QUEUE_NAME = process.env.SHOP_SYNC_QUEUE || "shop-sync-trigger";

const productService = new Services();
const collectionService = new CollectionService(shopify);

// ---- NEW: simple wait-and-retry helper for the "bulk op already running" race ----
// Instead of failing the instant Shopify says a bulk operation is running,
// we wait a few seconds and check again, a handful of times, before giving up.
const BULK_BUSY_RETRY_ATTEMPTS = 5; // how many times to check
const BULK_BUSY_RETRY_DELAY_MS = 5_000; // wait 5s between checks (~25s total)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBulkOperationToBeFree(session) {
  for (let attempt = 1; attempt <= BULK_BUSY_RETRY_ATTEMPTS; attempt++) {
    const { status } = await getCurrentBulkOperationStatus(session, "QUERY");

    if (status !== "RUNNING") {
      return { free: true, attempt };
    }

    logger.info("Bulk operation busy, waiting before retry", {
      worker: "shopSyncWorker",
      shop: session?.shop,
      attempt,
      maxAttempts: BULK_BUSY_RETRY_ATTEMPTS,
    });

    // Don't wait after the last attempt — just report busy and let the caller decide.
    if (attempt < BULK_BUSY_RETRY_ATTEMPTS) {
      await sleep(BULK_BUSY_RETRY_DELAY_MS);
    }
  }

  return { free: false, attempt: BULK_BUSY_RETRY_ATTEMPTS };
}
// -----------------------------------------------------------------------------------

async function tryAdvisoryLock(client, lockKey, transactional = true) {
  if (transactional) {
    const rows = await client.$queryRaw`
      SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})) AS locked
    `;
    return Boolean(rows?.[0]?.locked);
  }

  const rows = await client.$queryRaw`
    SELECT pg_try_advisory_lock(hashtext(${lockKey})) AS locked
  `;
  return Boolean(rows?.[0]?.locked);
}

async function unlockAdvisoryLock(client, lockKey) {
  await client.$queryRaw`
    SELECT pg_advisory_unlock(hashtext(${lockKey}))
  `;
}

const shopSyncWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { shop, syncType, reason } = job.data;
    if (!shop || !syncType) {
      throw new Error("shop-sync job requires shop and syncType");
    }

    const store = await prisma.store.findUnique({
      where: { shopUrl: shop },
      select: { isUnInstalled: true },
    });

    if (!store || store.isUnInstalled) {
      return {
        skipped: true,
        reason: "shop_unavailable",
      };
    }

    const lockKey = `shop-sync:${shop}:${syncType}`;
    const hasLock = await tryAdvisoryLock(prisma, lockKey, false);
    if (!hasLock) {
      throw new Error(`Another ${syncType} sync is already queued for this shop`);
    }

    let exclusiveShopLockKey = null;

    try {
      const exclusiveLock = await acquireExclusiveShopWork({
        shop,
        activity: `shop_${syncType}_sync`,
        worker: "shopSyncWorker",
        queue: QUEUE_NAME,
        jobId: job.id,
        entityType: "store",
        entityId: shop,
        executionId: `${syncType}:${shop}`,
      });

      if (!exclusiveLock.acquired) {
        throw new Error("Another heavy job is already running for this shop");
      }

      exclusiveShopLockKey = exclusiveLock.lockKey;

      if (syncType === "product") {
        await markInventoryReconciliationPending(shop).catch(() => {});
      }

      if (syncType === "collection") {
        await markCollectionReconciliationPending(shop).catch(() => {});
      }

      const session = await getSession(shop);

      // ---- CHANGED: wait-and-retry instead of failing immediately ----
      const { free, attempt } = await waitForBulkOperationToBeFree(session);

      if (!free) {
        // Still busy after several retries — this is a real, longer-running
        // conflict (not just two webhooks landing a second apart), so we
        // defer the job by re-throwing. BullMQ's existing retry/backoff
        // config on this queue will pick it up again later, and because
        // we never reached the point of mutating anything, there is no
        // need to mark the mirror as unsafe for this case.
        throw new Error(
          `A Shopify query bulk operation is still running after ${attempt} checks; deferring this ${syncType} sync`,
        );
      }
      // ------------------------------------------------------------------

      if (syncType === "product") {
        await productService.startBulkOperationToFetchProducts({ session });
      } else if (syncType === "collection") {
        await collectionService.clearCollections(session);
      } else {
        throw new Error(`Unsupported syncType: ${syncType}`);
      }

      logger.info("Webhook-triggered sync queued", {
        worker: "shopSyncWorker",
        jobId: job.id,
        shop,
        syncType,
        reason,
      });

      return {
        success: true,
        shop,
        syncType,
      };
    } catch (error) {
      await recordMirrorAnomaly({
        shop,
        severity: "medium",
        type: "shop_sync_worker_failure",
        entityType: "store",
        entityId: shop,
        message: error.message,
        details: { syncType, reason },
      }).catch(() => {});

      await markRepairRequired({
        shop,
        reason:
          syncType === "collection"
            ? MIRROR_STALE_REASONS.COLLECTION_RECONCILIATION_PENDING
            : MIRROR_STALE_REASONS.INVENTORY_RECONCILIATION_PENDING,
        summary: error.message,
        severity: "medium",
        details: { syncType, reason },
      }).catch(() => {});

      throw error;
    } finally {
      await releaseExclusiveShopWork(exclusiveShopLockKey);
      await unlockAdvisoryLock(prisma, lockKey).catch(() => {});
    }
  },
  {
    connection,
    concurrency: 1,
  },
);

shopSyncWorker.on("failed", (job, error) => {
  logger.error("Shop sync worker failed", {
    worker: "shopSyncWorker",
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    syncType: job?.data?.syncType,
    attempt: getJobAttempt(job),
    message: error.message,
  });
});

shopSyncWorker.on("completed", (job, result) => {
  logger.info("Shop sync worker completed", {
    worker: "shopSyncWorker",
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    syncType: job?.data?.syncType,
    attempt: getJobAttempt(job),
    result,
  });
});

shopSyncWorker.on("failed", async (job) => {
  if (isRetryExhausted(job)) {
    await recordRetryExhausted({
      job,
      shop: job?.data?.shop,
      worker: "shopSyncWorker",
      queue: QUEUE_NAME,
      entityType: "store",
      entityId: job?.data?.shop,
      executionId: `${job?.data?.syncType || "sync"}:${job?.data?.shop || "unknown"}`,
      message: "Shop sync worker exhausted retries",
      details: {
        syncType: job?.data?.syncType || null,
      },
    });
  }
});

export default shopSyncWorker;