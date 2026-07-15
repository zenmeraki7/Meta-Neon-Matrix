import { randomUUID } from "node:crypto";
import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
import { db } from "../../repositories/repositoryDb.js";
import logger from "../../utils/loggerUtils.js";
import { logWorkerError } from "../../utils/errorLogUtils.js";
import { markWebhookProcessed } from "../../services/mirrorHealthService.js";
import { recordMirrorAnomaly } from "../../services/mirrorAnomalyService.js";
import { enforceShopRateLimit } from "../../utils/shopRateLimit.js";

const QUEUE_NAME =
  process.env.NODE_ENV === "production"
    ? "product-delete"
    : "product-delete-job-dev";

function normalizeProductId(value) {
  const id = String(value || "").trim();
  if (/^gid:\/\/shopify\/Product\/\d+$/.test(id)) return id;
  if (/^\d+$/.test(id)) return `gid://shopify/Product/${id}`;
  return null;
}

function parseEventDate(value) {
  if (!value) return new Date();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

const productDeleteWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const shop = String(job.data?.shop || "").trim();
    const productId = normalizeProductId(job.data?.id);
    const sourceEventAt = parseEventDate(job.data?.occurredAt);

    if (!shop || !productId) {
      throw new Error(
        "product-delete job requires shop and a valid Shopify Product GID",
      );
    }

    await enforceShopRateLimit({
      connection,
      shop,
      scope: "product-delete",
      max: 10,
      durationMs: 1000,
    });

    try {
      const result = await db.$transaction(
        async (tx) => {
          const journal = await tx.mirrorMutationJournal.create({
            data: {
              shop,
              entityType: "PRODUCT",
              entityId: productId,
              productId,
              mutationType: "PRODUCT_DELETE",
              payload: {
                webhookId: job.data?.webhookId || null,
                topic: job.data?.topic || "PRODUCTS_DELETE",
              },
              sourceEventAt,
            },
            select: { sequence: true },
          });

          await tx.productTombstone.upsert({
            where: {
              shop_productId: { shop, productId },
            },
            create: {
              id: randomUUID(),
              shop,
              productId,
              mutationSequence: journal.sequence,
              sourceEventAt,
              deletedAt: sourceEventAt,
              sourceKind: "PRODUCTS_DELETE",
            },
            update: {
              mutationSequence: journal.sequence,
              sourceEventAt,
              deletedAt: sourceEventAt,
              sourceKind: "PRODUCTS_DELETE",
              updatedAt: new Date(),
            },
          });

          const inventoryItems = await tx.inventoryItemMirror.findMany({
            where: { shop, productId },
            select: { id: true, mirrorBatchId: true },
          });

          for (const item of inventoryItems) {
            await tx.inventoryLevelMirror.deleteMany({
              where: {
                shop,
                inventoryItemId: item.id,
                mirrorBatchId: item.mirrorBatchId,
              },
            });
          }

          await tx.inventoryItemMirror.deleteMany({
            where: { shop, productId },
          });
          await tx.productCollection.deleteMany({
            where: { shop, productId },
          });
          await tx.productMediaMirror.deleteMany({
            where: { shop, productId },
          });

          const variants = await tx.variant.findMany({
            where: { shop, productId },
            select: { id: true },
          });
          const variantIds = variants.map((row) => row.id);

          await tx.metafieldMirror.deleteMany({
            where: {
              shop,
              OR: [
                { ownerType: "PRODUCT", ownerId: productId },
                ...(variantIds.length > 0
                  ? [{ ownerType: "VARIANT", ownerId: { in: variantIds } }]
                  : []),
              ],
            },
          });

          await tx.variant.deleteMany({
            where: { shop, productId },
          });
          await tx.product.deleteMany({
            where: { shop, id: productId },
          });

          return { mutationSequence: journal.sequence };
        },
        {
          isolationLevel: "Serializable",
          maxWait: 10_000,
          timeout: 20_000,
        },
      );

      await markWebhookProcessed(shop, {
        lastIncrementalSyncAt: new Date(),
      }).catch(() => {});

      await Promise.allSettled([
        clearKeyCaches(`${shop}:ProductFetch`),
        clearKeyCaches(`${shop}:productTypes:`),
        clearKeyCaches(`${shop}:ProductFilterValues:`),
      ]);

      logger.info("Product delete webhook processed", {
        worker: "productDeleteWorker",
        jobId: job.id,
        shop,
        productId,
        mutationSequence: String(result.mutationSequence),
      });

      return {
        success: true,
        shop,
        productId,
        mutationSequence: String(result.mutationSequence),
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
    limiter: {
      max: 10,
      duration: 1000,
    },
  },
);

productDeleteWorker.on("failed", (job, error) => {
  logger.error("Product delete worker failed", {
    worker: "productDeleteWorker",
    jobId: job?.id,
    shop: job?.data?.shop,
    productId: job?.data?.id,
    message: error.message,
  });
});

export default productDeleteWorker;
