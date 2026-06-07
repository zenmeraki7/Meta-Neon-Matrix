import logger from "../../utils/loggerUtils.js";
import dayjs from "dayjs";
import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import CacheService from "../../utils/cacheService.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
import {
  extractVariantsForPrisma,
  transformWebhookPayload,
} from "../../utils/webhookTransformers.js";
import { enqueueAutomaticProductRuleSignalJob } from "../../services/automaticProductRuleExecutionService.js";
import { db } from "../../repositories/repositoryDb.js";
import {
  markWebhookProcessed,
  markRepairRequired,
  MIRROR_STALE_REASONS,
} from "../../services/mirrorHealthService.js";
import { recordMirrorAnomaly } from "../../services/mirrorAnomalyService.js";
import { addShopSyncJob } from "../Queues/shopSyncJob.js";
import { enforceShopRateLimit } from "../../utils/shopRateLimit.js";
import { PRODUCT_CREATE_QUEUE_NAME } from "../../queues/productWebhookQueue.constants.js";

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

const productCreateWorker = new Worker(
  PRODUCT_CREATE_QUEUE_NAME,
  async (job) => {
    try {
      const { shop, id: rawId, ...payload } = job.data;
      const id = normalizeProductId(rawId);
      if (!shop || !id) {
        throw new Error("product-create job requires shop and id");
      }
      await enforceShopRateLimit({
        connection,
        shop,
        scope: "product-create",
        max: 10,
        durationMs: 1000,
      });

      const cache = await CacheService.get(`${shop}:PRODUCT_CREATE`);
      if (cache) {
        return {
          message:
            "ignored product create webhook - bulk operation running in background",
        };
      }

      const store = await db.store.findUnique({
        where: { shopUrl: shop },
        select: { activeMirrorBatchId: true },
      });
      const activeMirrorBatchId = store?.activeMirrorBatchId || null;
      if (!activeMirrorBatchId) {
        await markRepairRequired({
          shop,
          reason: MIRROR_STALE_REASONS.PARTIAL_MIRROR_DETECTED,
          summary: "Product create webhook received without active mirror batch; repair sync required",
          details: { productId: id },
        }).catch(() => {});
        await addShopSyncJob({
          shop,
          syncType: "product",
          reason: "product_create_missing_active_batch",
        }).catch(() => {});
        return { skipped: true, reason: "missing_active_mirror_batch" };
      }

      const product = transformWebhookPayload(payload, shop);
      const variants = extractVariantsForPrisma(payload, id, shop);
      const incomingUpdatedAt = product.updatedAt ? new Date(product.updatedAt) : null;

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
            || !incomingUpdatedAt
            || incomingUpdatedAt <= new Date(tombstone.sourceUpdatedAt)
          )
        ) {
          skippedTombstonedPayload = true;
          return;
        }

        const current = await tx.product.findUnique({
          where: {
            shop_id_mirrorBatchId: {
              shop,
              id,
              mirrorBatchId: activeMirrorBatchId,
            },
          },
          select: { updatedAt: true },
        });

        if (
          current?.updatedAt &&
          incomingUpdatedAt &&
          new Date(current.updatedAt) > incomingUpdatedAt
        ) {
          skippedStalePayload = true;
          return;
        }

        await tx.product.deleteMany({
          where: {
            shop,
            id,
            mirrorBatchId: activeMirrorBatchId,
          },
        });

        await tx.product.create({
          data: {
            shop,
            id,
            mirrorBatchId: activeMirrorBatchId,
            ...product,
          },
        });

        await tx.variant.deleteMany({
          where: {
            shop,
            productId: id,
            mirrorBatchId: activeMirrorBatchId,
          },
        });

        if (variants.length > 0) {
          await tx.variant.createMany({
            data: variants.map((variant) => ({
              shop,
              id: variant.id,
              productId: id,
              mirrorBatchId: activeMirrorBatchId,
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
          message: "Ignored product create webhook for tombstoned product",
          details: {
            incomingUpdatedAt,
            activeMirrorBatchId,
          },
        }).catch(() => {});

        return { skipped: true, reason: "tombstoned_product_create_webhook" };
      }

      if (skippedStalePayload) {
        await recordMirrorAnomaly({
          shop,
          severity: "medium",
          type: "webhook_out_of_order",
          entityType: "product",
          entityId: id,
          message: "Ignored stale product create webhook during atomic write",
          details: {
            incomingUpdatedAt,
            activeMirrorBatchId,
          },
        }).catch(() => {});

        return { skipped: true, reason: "stale_product_create_webhook" };
      }

      await markWebhookProcessed(shop, {
        lastIncrementalSyncAt: new Date(),
      }).catch(() => {});

      await clearKeyCaches(`${shop}:ProductFetch:`);
      await clearKeyCaches(`${shop}:productTypes:`);
      await clearKeyCaches(`${shop}:ProductFilterValues:`);
      await enqueueAutomaticProductRuleSignalJob({
        shop,
        productIds: [id],
        triggerReference: `product_create:${id}:${payload.updated_at || payload.created_at || ""}`,
        triggerSource: "WEBHOOK",
      });

      return { success: true, productId: id };
    } catch (err) {
      await recordMirrorAnomaly({
        shop: job.data?.shop || "unknown",
        severity: "high",
        type: "product_create_worker_failure",
        entityType: "product",
        entityId: job.data?.id || null,
        message: err.message,
      }).catch(() => {});
      throw err;
    }
  },
  {
    connection,
    concurrency: 5,
    limiter: {
      max: 10,
      duration: 1000,
    },
  },
);

const logTime = () => `[${dayjs().format("YYYY-MM-DD HH:mm:ss")}]`;

if (process.env.NODE_ENV !== "production") {
  productCreateWorker
    .on("error", (err) => {
      logger.error(
        `${logTime()} Queue Error in productCreateWorker: ${err.message}`,
        {
          stack: err.stack,
        },
      );
    })
    .on("waiting", (jobId) => {
      logger.info(
        `${logTime()} productCreateWorker - Job waiting | Job ID: ${jobId}`,
      );
    })
    .on("active", (job) => {
      logger.info(
        `${logTime()} productCreateWorker - Job started | Job ID: ${job.id}`,
      );
    })
    .on("completed", (job, result) => {
      logger.info(
        `${logTime()} productCreateWorker - Job completed | Job ID: ${job.id}`,
        { result },
      );
    })
    .on("failed", (job, err) => {
      logger.error(
        `${logTime()} productCreateWorker - Job failed | Job ID: ${job.id} | Error: ${err.message}`,
        { error: err },
      );
    });
}

export default productCreateWorker;
