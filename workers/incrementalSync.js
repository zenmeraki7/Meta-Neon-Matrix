import shopify from "../web/shopify.js";
import { startJob, completeJob, failJob } from "../db/syncJobs.js";
import { getActiveBatch } from "../db/mirrorBatches.js";
import {
  reconcileVariants,
  softDeleteProduct,
  upsertProducts,
  upsertVariants,
} from "../db/products.js";
import { clearSyncJob } from "../db/productSyncJobs.js";
import { fetchProduct } from "../lib/shopify/fetchProduct.js";

/**
 * Runs incremental product sync job.
 * @param {object} job
 * @returns {Promise<void>}
 */
export async function runIncrementalSync(job) {
  const meta = job?.meta && typeof job.meta === "object" ? job.meta : {};
  const productIdString = String(meta.productId || "").trim();
  let productId = null;

  try {
    await startJob(job.id);
    if (!productIdString) {
      throw new Error("INCREMENTAL_SYNC requires meta.productId");
    }
    productId = BigInt(productIdString);

    const offlineSession = await shopify.sessionStorage.loadSession(`${job.shop_id}_offline`);
    if (!offlineSession?.accessToken) {
      throw new Error(`Offline session missing for ${job.shop_id}`);
    }

    const activeBatch = await getActiveBatch(job.shop_id);
    if (!activeBatch) {
      await failJob(job.id, "No active mirror batch. Run full sync first.");
      return;
    }

    const product = await fetchProduct(
      job.shop_id,
      offlineSession.accessToken,
      productId,
    );

    if (!product) {
      await softDeleteProduct(job.shop_id, productId, "SHOPIFY_WEBHOOK_DELETE");
    } else {
      await upsertProducts(job.shop_id, activeBatch.id, [product]);
      await upsertVariants(job.shop_id, activeBatch.id, product.variants || []);
      await reconcileVariants(
        job.shop_id,
        productId,
        (product.variants || []).map((variant) => variant.id),
      );
    }

    await clearSyncJob(job.shop_id, productId);
    await completeJob(job.id);
  } catch (error) {
    if (productId !== null) {
      try {
        await clearSyncJob(job.shop_id, productId);
      } catch (innerError) {
        console.error("[runIncrementalSync] clearSyncJob error", innerError?.message || innerError);
      }
    }
    try {
      await failJob(job.id, error?.message || "Incremental sync failed");
    } catch (innerError) {
      console.error("[runIncrementalSync] failJob error", innerError?.message || innerError);
    }
    console.error("[runIncrementalSync] error", {
      jobId: job?.id || null,
      shop: job?.shop_id || null,
      message: error?.message || String(error),
    });
  }
}

