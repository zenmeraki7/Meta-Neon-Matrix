import { QueueEvents, Worker } from "bullmq";
import { connection, createRedisConnection } from "../../config/redis.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
import { db } from "../../repositories/repositoryDb.js";
import logger from "../../utils/loggerUtils.js";
import { logWorkerError } from "../../utils/errorLogUtils.js";
import { markWebhookProcessed } from "../../services/mirrorHealthService.js";
import { recordMirrorAnomaly } from "../../services/mirrorAnomalyService.js";
import { enforceShopRateLimit } from "../../utils/shopRateLimit.js";
import {
  PRODUCT_DELETE_DLQ_QUEUE_NAME,
  PRODUCT_DELETE_QUEUE_NAME,
} from "../../queues/productWebhookQueue.constants.js";
import { productDeleteDlqQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";
import { isRetryExhausted } from "../../utils/workerTelemetry.js";

function normalizeProductId(id) {
  if (
    (typeof id !== "string" && typeof id !== "number") ||
    String(id).trim() === ""
  ) {
    return null;
  }

  const normalizedId = String(id).trim();
  const numericId = normalizedId.startsWith("gid://shopify/Product/")
    ? normalizedId.slice("gid://shopify/Product/".length)
    : normalizedId;
  if (!/^\d+$/.test(numericId)) {
    return null;
  }

  return `gid://shopify/Product/${numericId}`;
}

const productDeleteWorker = new Worker(
  PRODUCT_DELETE_QUEUE_NAME,
  async (job) => {
    const shop = job.data?.shop;
    const productId = normalizeProductId(job.data?.id);

    try {
      if (!shop || !productId) {
        throw new Error("product-delete job requires shop and id");
      }

      await enforceShopRateLimit({
        connection,
        shop,
        scope: "product-delete",
        max: 10,
        durationMs: 1000,
      });

      const deletion = await db.$transaction(async (tx) => {
        const store = await tx.store.findUnique({
          where: { shopUrl: shop },
          select: {
            activeMirrorBatchId: true,
            isUnInstalled: true,
          },
        });

        if (!store || store.isUnInstalled) {
          return { skipped: true, reason: "shop_not_installed" };
        }

        const activeMirrorBatchId = store.activeMirrorBatchId;
        if (!activeMirrorBatchId) {
          return { skipped: true, reason: "missing_active_mirror_batch" };
        }

        // Variants must be removed first because their product relation uses ON DELETE RESTRICT.
        const variantsDeleted = await tx.variant.deleteMany({
          where: {
            shop,
            productId,
            mirrorBatchId: activeMirrorBatchId,
          },
        });

        const productDeleted = await tx.product.deleteMany({
          where: {
            shop,
            id: productId,
            mirrorBatchId: activeMirrorBatchId,
          },
        });

        return {
          skipped: false,
          activeMirrorBatchId,
          deleted: productDeleted.count > 0,
          productDeleteCount: productDeleted.count,
          variantDeleteCount: variantsDeleted.count,
          changed: productDeleted.count > 0 || variantsDeleted.count > 0,
        };
      });

      if (deletion.skipped) {
        logger.info("Product delete webhook skipped", {
          worker: "productDeleteWorker",
          jobId: job.id,
          shop,
          productId,
          reason: deletion.reason,
        });
        return {
          success: true,
          skipped: true,
          reason: deletion.reason,
          shop,
          productId,
        };
      }

      if (!deletion.changed) {
        logger.info("Product delete webhook was already applied", {
          worker: "productDeleteWorker",
          jobId: job.id,
          shop,
          productId,
          activeMirrorBatchId: deletion.activeMirrorBatchId,
        });
        return {
          success: true,
          deleted: false,
          reason: "already_deleted",
          shop,
          productId,
        };
      }

      await markWebhookProcessed(shop, {
        lastIncrementalSyncAt: new Date(),
      }).catch(() => {});

      await Promise.all([
        clearKeyCaches(`${shop}:ProductFetch:`),
        clearKeyCaches(`${shop}:productTypes:`),
        clearKeyCaches(`${shop}:ProductFilterValues:`),
      ]).catch((error) => {
        logger.warn("Product delete cache invalidation failed", {
          worker: "productDeleteWorker",
          shop,
          productId,
          message: error?.message,
        });
      });

      logger.info("Product delete webhook processed", {
        worker: "productDeleteWorker",
        jobId: job.id,
        shop,
        productId,
        activeMirrorBatchId: deletion.activeMirrorBatchId,
        productDeleteCount: deletion.productDeleteCount,
        variantDeleteCount: deletion.variantDeleteCount,
      });

      return {
        success: true,
        deleted: deletion.deleted,
        shop,
        productId,
      };
    } catch (error) {
      await recordMirrorAnomaly({
        shop,
        severity: "high",
        type: "product_delete_worker_failure",
        entityType: "product",
        entityId: productId,
        message: error.message,
      }).catch(() => {});

      await logWorkerError({
        shop,
        err: error,
        source: "productDeleteWorker",
      });
      throw error;
    }
  },
  {
    connection,
    concurrency: 5,
    lockDuration: Number(process.env.PRODUCT_DELETE_LOCK_DURATION_MS || 300_000),
    stalledInterval: Number(process.env.PRODUCT_DELETE_STALLED_INTERVAL_MS || 60_000),
    maxStalledCount: Number(process.env.PRODUCT_DELETE_MAX_STALLED_COUNT || 1),
    limiter: {
      max: 10,
      duration: 1000,
    },
  },
);

const productDeleteQueueEvents = new QueueEvents(PRODUCT_DELETE_QUEUE_NAME, {
  connection: createRedisConnection(),
});

productDeleteWorker.on("completed", (job, result) => {
  logger.info("Product delete worker completed", {
    worker: "productDeleteWorker",
    jobId: job?.id,
    shop: job?.data?.shop,
    productId: job?.data?.id,
    deleted: Boolean(result?.deleted),
    skipped: Boolean(result?.skipped),
    reason: result?.reason || null,
  });
});

productDeleteWorker.on("failed", (job, error) => {
  logger.error("Product delete worker failed", {
    worker: "productDeleteWorker",
    jobId: job?.id,
    shop: job?.data?.shop,
    productId: job?.data?.id,
    attemptsMade: job?.attemptsMade,
    message: error?.message,
    stack: error?.stack,
  });
  if (isRetryExhausted(job)) {
    void productDeleteDlqQueue.add(
      PRODUCT_DELETE_DLQ_QUEUE_NAME,
      {
        originalJobId: job?.id,
        data: job?.data,
        failedReason: error?.message,
        stack: error?.stack,
        failedAt: new Date().toISOString(),
      },
      { jobId: `dlq:${PRODUCT_DELETE_QUEUE_NAME}:${job?.id}` },
    ).catch((dlqError) => {
      logger.error("Product delete DLQ enqueue failed", {
        worker: "productDeleteWorker",
        jobId: job?.id,
        message: dlqError?.message,
      });
    });
  }
});

productDeleteWorker.on("error", (error) => {
  logger.error("Product delete worker runtime error", {
    worker: "productDeleteWorker",
    message: error?.message,
    stack: error?.stack,
  });
});

productDeleteQueueEvents.on("stalled", ({ jobId }) => {
  logger.warn("Product delete queue job stalled", {
    worker: "productDeleteWorker",
    jobId,
  });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await productDeleteWorker.close();
    await productDeleteQueueEvents.close();
  } catch (error) {
    logger.error("Product delete worker shutdown failed", {
      worker: "productDeleteWorker",
      signal,
      message: error?.message,
    });
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

export default productDeleteWorker;
