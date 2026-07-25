import { createJob } from "../../db/syncJobs.js";
import sql from "../../db/client.js";
import { isDuplicateDelivery } from "../../db/webhookDeliveries.js";
import { coalesceSyncJob } from "../../db/productSyncJobs.js";

/**
 * Handles PRODUCTS_UPDATE webhook.
 * @param {{ topic: string, shop: string, body: object, deliveryId: string }} payload
 * @returns {Promise<void>}
 * @throws {Error}
 */
export default async function handler({ topic, shop, body, deliveryId }) {
  const shopDomain = String(shop || "").trim();
  const webhookId = String(deliveryId || "").trim();
  if (!shopDomain || !webhookId) return;

  const duplicate = await isDuplicateDelivery(shopDomain, webhookId, topic);
  if (duplicate) {
    console.log("[productsUpdate] duplicate delivery skipped", { shop: shopDomain, deliveryId: webhookId });
    return;
  }

  const productId = BigInt(body?.id);
  const existing = await sql`
    SELECT job_id
    FROM product_sync_jobs
    WHERE shop_id = ${shopDomain}
      AND product_id = ${productId.toString()}::bigint
    LIMIT 1
  `;
  if (existing.length > 0) {
    console.log("[productsUpdate] coalesced away", { shop: shopDomain, productId: productId.toString() });
    return;
  }

  const job = await createJob({
    shopDomain,
    type: "INCREMENTAL_SYNC",
    meta: {
      productId: productId.toString(),
      webhookTopic: topic,
    },
  });

  await coalesceSyncJob(shopDomain, productId, job.id);
}

