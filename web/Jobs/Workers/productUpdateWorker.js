import logger from "../../utils/loggerUtils.js";
import { QueueEvents, Worker } from "bullmq";
import { connection, createRedisConnection } from "../../config/redis.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
import {
  extractVariantsForPrisma,
  transformWebhookPayload,
} from "../../utils/webhookTransformers.js";
import { enqueueAutomaticProductRuleSignalJob } from "../../services/automaticProductRuleExecutionService.js";
import { db } from "../../repositories/repositoryDb.js";
import {
  markRepairRequired,
  markWebhookProcessed,
  MIRROR_STALE_REASONS,
} from "../../services/mirrorHealthService.js";
import { recordMirrorAnomaly } from "../../services/mirrorAnomalyService.js";
import { addShopSyncJob } from "../Queues/shopSyncJob.js";
import { enforceShopRateLimit } from "../../utils/shopRateLimit.js";
import { PRODUCT_UPDATE_QUEUE_NAME } from "../../queues/productWebhookQueue.constants.js";
import { productUpdateDlqQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";
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

async function acquireProductWebhookLock(tx, shop, productId) {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtext(${`product-webhook:${shop}:${productId}`}))
  `;
}

const productUpdateWorker = new Worker(
  PRODUCT_UPDATE_QUEUE_NAME,
  async (job) => {
    try {
      const { shop, id: rawId, ...payload } = job.data;
      const id = normalizeProductId(rawId);
      if (!shop || !id) {
        throw new Error("product-update job requires shop and id");
      }
      const store = await db.store.findUnique({
        where: { shopUrl: shop },
        select: {
          activeMirrorBatchId: true,
          isUnInstalled: true,
        },
      });
      if (!store || store.isUnInstalled) {
        return { skipped: true, reason: "shop_not_installed" };
      }

      await enforceShopRateLimit({
        connection,
        shop,
        scope: "product-update",
        max: 10,
        durationMs: 1000,
      });
      const transformedData = transformWebhookPayload(payload, shop);
      const incomingUpdatedAt = transformedData.updatedAt
        ? new Date(transformedData.updatedAt)
        : null;
      if (!incomingUpdatedAt) {
        await markRepairRequired({
          shop,
          reason: MIRROR_STALE_REASONS.PARTIAL_MIRROR_DETECTED,
          summary: "Product update webhook missing updated_at; repair sync required",
          details: { productId: id },
        }).catch(() => {});
        await addShopSyncJob({
          shop,
          syncType: "product",
          reason: "product_update_missing_updated_at",
        }).catch(() => {});
        return { skipped: true, reason: "missing_updated_at_repair_scheduled" };
      }
      const activeBatchId = store?.activeMirrorBatchId || null;
      if (!activeBatchId) {
        await markRepairRequired({
          shop,
          reason: MIRROR_STALE_REASONS.PARTIAL_MIRROR_DETECTED,
          summary: "Product update webhook received without active mirror batch; repair sync required",
          details: { productId: id },
        }).catch(() => {});

        await addShopSyncJob({
          shop,
          syncType: "product",
          reason: "product_update_missing_active_batch",
        }).catch(() => {});

        return { skipped: true, reason: "missing_active_mirror_batch" };
      }

      const existingScoped = await db.product.findFirst({
        where: {
          shop,
          id,
          mirrorBatchId: activeBatchId,
        },
        select: {
          updatedAt: true,
          mirrorBatchId: true,
        },
      });

      if (
        existingScoped?.updatedAt &&
        incomingUpdatedAt &&
        incomingUpdatedAt < new Date(existingScoped.updatedAt)
      ) {
        await recordMirrorAnomaly({
          shop,
          severity: "medium",
          type: "webhook_out_of_order",
          entityType: "product",
          entityId: id,
          message: "Ignored older product update webhook payload",
          details: {
            existingUpdatedAt: existingScoped.updatedAt,
            incomingUpdatedAt,
          },
        });

        return { skipped: true, reason: "out_of_order_webhook" };
      }

      const variants = Array.isArray(payload.variants)
        ? extractVariantsForPrisma(payload, id, shop)
        : null;

      if (!variants) {
        await markRepairRequired({
          shop,
          reason: MIRROR_STALE_REASONS.PRODUCT_WEBHOOK_MISSING_VARIANTS,
          summary: "Product update webhook missing variants payload; repair sync required",
          details: { productId: id },
        }).catch(() => { });

        await addShopSyncJob({
          shop,
          syncType: "product",
          reason: "product_update_missing_variants",
        }).catch(() => { });
        return { skipped: true, reason: "missing_variants_repair_scheduled" };
      }

      let skippedStalePayload = false;
      let skippedTombstonedPayload = false;
      await db.$transaction(async (tx) => {
        await acquireProductWebhookLock(tx, shop, id);
        const tombstone = await tx.productTombstone.findUnique({
          where: {
            shop_productId: {
              shop,
              productId: id,
            },
          },
          select: { sourceUpdatedAt: true },
        });
        if (
          tombstone
          && (
            !tombstone.sourceUpdatedAt
            || incomingUpdatedAt <= new Date(tombstone.sourceUpdatedAt)
          )
        ) {
          skippedTombstonedPayload = true;
          return;
        }

        const updated = await tx.product.updateMany({
          where: {
            shop,
            id,
            mirrorBatchId: activeBatchId,
            ...(incomingUpdatedAt
              ? {
                  OR: [
                    { updatedAt: null },
                    { updatedAt: { lte: incomingUpdatedAt } },
                  ],
                }
              : {}),
          },
          data: {
            ...transformedData,
          },
        });

        if (!updated.count) {
          const current = await tx.product.findUnique({
            where: {
              shop_id_mirrorBatchId: {
                shop,
                id,
                mirrorBatchId: activeBatchId,
              },
            },
            select: { updatedAt: true },
          });

          if (current) {
            skippedStalePayload = true;
            return;
          }

          await tx.product.create({
            data: {
              shop,
              id,
              mirrorBatchId: activeBatchId,
              ...transformedData,
            },
          });
        }

        if (variants && variants.length > 0) {
          const incomingIds = variants.map((variant) => variant.id);
          await tx.variant.deleteMany({
            where: {
              shop,
              productId: id,
              mirrorBatchId: activeBatchId,
              id: { in: incomingIds },
            },
          });
          await tx.variant.createMany({
            data: variants.map((variant) => ({
              shop,
              id: variant.id,
              productId: id,
              mirrorBatchId: activeBatchId,
              title: variant.title ?? null,
              sku: variant.sku ?? null,
              barcode: variant.barcode ?? null,
              price: variant.price ?? null,
              compareAtPrice: variant.compareAtPrice ?? null,
              inventoryQuantity: variant.inventoryQuantity ?? null,
              inventoryPolicy: variant.inventoryPolicy ?? null,
              taxable: variant.taxable ?? null,
              taxCode: variant.taxCode ?? null,
              position: variant.position ?? null,
              selectedOptionsJson: variant.selectedOptionsJson ?? null,
              option1Value: variant.selectedOptionsJson?.[0]?.value ?? null,
              option2Value: variant.selectedOptionsJson?.[1]?.value ?? null,
              option3Value: variant.selectedOptionsJson?.[2]?.value ?? null,
            })),
          });
        }
      });

      if (skippedTombstonedPayload) {
        await recordMirrorAnomaly({
          shop,
          severity: "medium",
          type: "webhook_after_delete",
          entityType: "product",
          entityId: id,
          message: "Ignored product update webhook for tombstoned product",
          details: {
            incomingUpdatedAt,
            activeBatchId,
          },
        }).catch(() => {});

        return { skipped: true, reason: "tombstoned_product_update_webhook" };
      }

      if (skippedStalePayload) {
        await recordMirrorAnomaly({
          shop,
          severity: "medium",
          type: "webhook_out_of_order",
          entityType: "product",
          entityId: id,
          message: "Ignored stale product update webhook during atomic write",
          details: {
            incomingUpdatedAt,
            activeBatchId,
          },
        }).catch(() => {});

        return { skipped: true, reason: "stale_product_update_webhook" };
      }

      await markWebhookProcessed(shop, {
        lastIncrementalSyncAt: new Date(),
      }).catch(() => { });

      await Promise.all([
        clearKeyCaches(`${shop}:ProductFetch:`),
        clearKeyCaches(`${shop}:productTypes:`),
        clearKeyCaches(`${shop}:ProductFilterValues:`),
      ]).catch((error) => {
        logger.warn("Product update cache invalidation failed", {
          worker: "productUpdateWorker",
          shop,
          productId: id,
          message: error?.message,
        });
      });
      await enqueueAutomaticProductRuleSignalJob({
        shop,
        productIds: [id],
        triggerReference: `product_update:${id}:${payload.updated_at || payload.created_at || ""}`,
        triggerSource: "WEBHOOK",
      });

      return { success: true, productId: id };
    } catch (err) {
      await recordMirrorAnomaly({
        shop: job.data?.shop || "unknown",
        severity: "high",
        type: "product_update_worker_failure",
        entityType: "product",
        entityId: job.data?.id || null,
        message: err.message,
      }).catch(() => { });
      throw err;
    }
  },
  {
    connection,
    concurrency: 5,
    lockDuration: Number(process.env.PRODUCT_UPDATE_LOCK_DURATION_MS || 300_000),
    stalledInterval: Number(process.env.PRODUCT_UPDATE_STALLED_INTERVAL_MS || 60_000),
    maxStalledCount: Number(process.env.PRODUCT_UPDATE_MAX_STALLED_COUNT || 1),
    limiter: {
      max: 10,
      duration: 1000,
    },
  },
);

const productUpdateQueueEvents = new QueueEvents(PRODUCT_UPDATE_QUEUE_NAME, {
  connection: createRedisConnection(),
});

productUpdateWorker.on("completed", (job, result) => {
  logger.info("Product update worker completed", {
    worker: "productUpdateWorker",
    jobId: job?.id,
    shop: job?.data?.shop,
    productId: job?.data?.id,
    skipped: Boolean(result?.skipped),
    reason: result?.reason || null,
  });
});

productUpdateWorker.on("failed", (job, error) => {
  logger.error("Product update worker failed", {
    worker: "productUpdateWorker",
    jobId: job?.id,
    shop: job?.data?.shop,
    productId: job?.data?.id,
    attemptsMade: job?.attemptsMade,
    message: error?.message,
    stack: error?.stack,
  });
  if (isRetryExhausted(job)) {
    void productUpdateDlqQueue.add(
      "product-update-dlq",
      {
        originalJobId: job?.id,
        data: job?.data,
        failedReason: error?.message,
        stack: error?.stack,
        failedAt: new Date().toISOString(),
      },
      { jobId: `dlq:${PRODUCT_UPDATE_QUEUE_NAME}:${job?.id}` },
    ).catch((dlqError) => {
      logger.error("Product update DLQ enqueue failed", {
        worker: "productUpdateWorker",
        jobId: job?.id,
        message: dlqError?.message,
      });
    });
  }
});

productUpdateWorker.on("error", (error) => {
  logger.error("Product update worker runtime error", {
    worker: "productUpdateWorker",
    message: error?.message,
    stack: error?.stack,
  });
});

productUpdateQueueEvents.on("stalled", ({ jobId }) => {
  logger.warn("Product update queue job stalled", {
    worker: "productUpdateWorker",
    jobId,
  });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await productUpdateWorker.close();
    await productUpdateQueueEvents.close();
  } catch (error) {
    logger.error("Product update worker shutdown failed", {
      worker: "productUpdateWorker",
      signal,
      message: error?.message,
    });
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

export default productUpdateWorker;
