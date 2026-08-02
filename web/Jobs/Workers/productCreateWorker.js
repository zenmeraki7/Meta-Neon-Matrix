import logger from "../../utils/loggerUtils.js";
import dayjs from "dayjs";
import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
import { extractVariantsForPrisma, transformWebhookPayload } from "../../utils/webhookTransformers.js";
import { enqueueAutomaticProductRuleSignalJob } from "../../services/automaticProductRuleExecutionService.js";
import { db } from "../../repositories/repositoryDb.js";
import { applyProductUpsertMutation } from "../../repositories/mirrorMutationRepository.js";
import { markWebhookProcessed, markRepairRequired, MIRROR_STALE_REASONS } from "../../services/mirrorHealthService.js";
import { recordMirrorAnomaly } from "../../services/mirrorAnomalyService.js";
import { addShopSyncJob } from "../Queues/shopSyncJob.js";
import { enforceShopRateLimit } from "../../utils/shopRateLimit.js";

const QUEUE_NAME = process.env.NODE_ENV === "production" ? "product-create" : "product-create-job-dev";

const productCreateWorker = new Worker(QUEUE_NAME, async (job) => {
  const { shop, id, webhookDeliveryId = null, ...payload } = job.data || {};
  if (!shop || !id) throw new Error("product-create requires shop and id");

  await enforceShopRateLimit({ connection, shop, scope: "product-create", max: 10, durationMs: 1000 });

  try {
    const store = await db.store.findUnique({ where: { shopUrl: shop }, select: { currentProductMirrorBatchId: true, installationStatus: true } });
    if (!store || store.installationStatus !== "INSTALLED") {
      return { skipped: true, reason: "store_not_installed" };
    }
    const mirrorBatchId = store?.currentProductMirrorBatchId || null;
    if (!mirrorBatchId) {
      await markRepairRequired({
        shop,
        reason: MIRROR_STALE_REASONS.PARTIAL_MIRROR_DETECTED,
        summary: "Product create webhook received without active mirror",
        details: { productId: id },
      }).catch(() => {});
      await addShopSyncJob({ shopDomain: shop, syncType: "product", reason: "product_create_missing_active_batch" }).catch(() => {});
      return { skipped: true, reason: "missing_active_mirror_batch" };
    }

    const productData = transformWebhookPayload(payload, shop);
    const variants = extractVariantsForPrisma(payload, id, shop);
    const sourceEventOccurredAt = productData.updatedAt ? new Date(productData.updatedAt) : new Date();

    const current = await db.product.findUnique({
      where: { shop_id_mirrorBatchId: { shop, id, mirrorBatchId } },
      select: { updatedAt: true },
    });
    if (current?.updatedAt && sourceEventOccurredAt < new Date(current.updatedAt)) {
      return { skipped: true, reason: "stale_product_create_webhook" };
    }

    const journal = await applyProductUpsertMutation({
      shop,
      productId: id,
      mirrorBatchId,
      mutationType: "PRODUCT_CREATE",
      productData,
      variants,
      sourceEventOccurredAt,
      webhookDeliveryId,
    });
    if (journal?.skipped) return { skipped: true, reason: journal.reason };

    await markWebhookProcessed(shop, { lastIncrementalSyncAt: new Date() }).catch(() => {});
    await Promise.allSettled([
      clearKeyCaches(`${shop}:ProductFetch:`),
      clearKeyCaches(`${shop}:productTypes:`),
      clearKeyCaches(`${shop}:ProductFilterValues:`),
    ]);
    await enqueueAutomaticProductRuleSignalJob({
      shop,
      productIds: [id],
      triggerReference: `product_create:${id}:${payload.updated_at || payload.created_at || ""}`,
      triggerSource: "WEBHOOK",
    });

    return { success: true, productId: id, mirrorMutationSequence: String(journal.sequence) };
  } catch (error) {
    if (webhookDeliveryId) {
      await db.webhookDelivery.updateMany({
        where: { id: webhookDeliveryId, shop },
        data: {
          lastError: String(error?.message || error).slice(0, 1000),
          attemptCount: { increment: 1 },
          updatedAt: new Date(),
        },
      }).catch(() => {});
    }
    await recordMirrorAnomaly({ shop, severity: "high", type: "product_create_worker_failure", entityType: "product", entityId: id, message: error.message }).catch(() => {});
    throw error;
  }
}, { connection, concurrency: 5, limiter: { max: 10, duration: 1000 } });

const logTime = () => `[${dayjs().format("YYYY-MM-DD HH:mm:ss")}]`;
productCreateWorker.on("failed", (job, error) => logger.error(`${logTime()} productCreateWorker failed`, { jobId: job?.id, message: error.message }));
export default productCreateWorker;
