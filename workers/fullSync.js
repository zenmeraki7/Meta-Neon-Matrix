import shopify from "../web/shopify.js";
import { startJob, completeJob, failJob, incrementProgress, updateJobMeta } from "../db/syncJobs.js";
import { createBatch, activateBatch, failBatch } from "../db/mirrorBatches.js";
import { upsertProducts, upsertVariants } from "../db/products.js";
import { updateLastSynced } from "../db/shops.js";
import {
  downloadAndParseJSONL,
  pollBulkOperation,
  startBulkProductSync,
} from "../lib/shopify/bulkOperations.js";

export const BATCH_SIZE = 100;
const POLL_MS = 3000;
const TIMEOUT_MS = 30 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs full sync lane worker.
 * @param {object} job
 * @returns {Promise<void>}
 */
export async function runFullSync(job) {
  let batch = null;
  try {
    await startJob(job.id);
    batch = await createBatch({
      shopId: job.shop_id,
      source: "FULL_SYNC",
      jobId: job.id,
    });

    const offlineSession = await shopify.sessionStorage.loadSession(`${job.shop_id}_offline`);
    if (!offlineSession?.accessToken) {
      throw new Error(`Offline session missing for ${job.shop_id}`);
    }

    const bulkOperationId = await startBulkProductSync(
      job.shop_id,
      offlineSession.accessToken,
    );

    await updateJobMeta(job.id, {
      bulkOperationId: bulkOperationId.toString(),
      batchId: batch.id,
    });

    const startedAt = Date.now();
    let resultUrl = null;
    while (Date.now() - startedAt < TIMEOUT_MS) {
      // eslint-disable-next-line no-await-in-loop
      const state = await pollBulkOperation(
        job.shop_id,
        offlineSession.accessToken,
        bulkOperationId,
      );

      if (state.status === "COMPLETED") {
        resultUrl = state.url;
        break;
      }
      if (state.status === "FAILED" || state.status === "CANCELED") {
        throw new Error(`Bulk operation ended with status ${state.status}`);
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(POLL_MS);
    }

    if (!resultUrl) {
      throw new Error("Bulk sync timed out after 30 minutes");
    }

    const products = await downloadAndParseJSONL(resultUrl);
    let productCount = 0;
    let variantCount = 0;

    for (let i = 0; i < products.length; i += BATCH_SIZE) {
      const chunk = products.slice(i, i + BATCH_SIZE);
      // eslint-disable-next-line no-await-in-loop
      const flatVariants = chunk.flatMap((item) => item.variants || []);
      // eslint-disable-next-line no-await-in-loop
      await upsertProducts(job.shop_id, batch.id, chunk);
      // eslint-disable-next-line no-await-in-loop
      await upsertVariants(job.shop_id, batch.id, flatVariants);
      productCount += chunk.length;
      variantCount += flatVariants.length;
      // eslint-disable-next-line no-await-in-loop
      await incrementProgress(job.id, { processed: chunk.length, errors: 0 });
    }

    await activateBatch(batch.id, { productCount, variantCount });
    await completeJob(job.id);
    await updateLastSynced(job.shop_id);
  } catch (error) {
    if (batch?.id) {
      try {
        await failBatch(batch.id);
      } catch (innerError) {
        console.error("[runFullSync] failBatch error", innerError?.message || innerError);
      }
    }
    try {
      await failJob(job.id, error?.message || "Full sync failed");
    } catch (innerError) {
      console.error("[runFullSync] failJob error", innerError?.message || innerError);
    }
    console.error("[runFullSync] error", {
      jobId: job?.id || null,
      shop: job?.shop_id || null,
      message: error?.message || String(error),
    });
  }
}

