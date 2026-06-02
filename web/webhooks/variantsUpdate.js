import { createJob } from "../../db/syncJobs.js";
import sql from "../../db/client.js";
import { isDuplicateDelivery } from "../../db/webhookDeliveries.js";
import { coalesceSyncJob } from "../../db/productSyncJobs.js";

export default async function handler({ topic, shop, body, deliveryId }) {
  const shopId = String(shop || "").trim();
  const webhookId = String(deliveryId || "").trim();
  if (!shopId || !webhookId) return;

  const duplicate = await isDuplicateDelivery(shopId, webhookId, topic);
  if (duplicate) {
    console.log("[variantsUpdate] duplicate delivery skipped", { shop: shopId, deliveryId: webhookId });
    return;
  }

  const productIdRaw = body?.product_id ?? body?.productId;
  if (productIdRaw == null) {
    console.log("[variantsUpdate] missing product_id; skip", { shop: shopId, deliveryId: webhookId });
    return;
  }
  const productId = BigInt(productIdRaw);

  const existing = await sql`
    SELECT job_id
    FROM product_sync_jobs
    WHERE shop_id = ${shopId}
      AND product_id = ${productId.toString()}::bigint
    LIMIT 1
  `;
  if (existing.length > 0) {
    console.log("[variantsUpdate] coalesced away", { shop: shopId, productId: productId.toString() });
    return;
  }

  const job = await createJob({
    shopId,
    type: "INCREMENTAL_SYNC",
    meta: {
      productId: productId.toString(),
      webhookTopic: topic,
    },
  });

  await coalesceSyncJob(shopId, productId, job.id);
}

