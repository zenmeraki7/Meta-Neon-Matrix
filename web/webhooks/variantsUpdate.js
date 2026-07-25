import { createJob } from "../../db/syncJobs.js";
import sql from "../../db/client.js";
import { isDuplicateDelivery } from "../../db/webhookDeliveries.js";
import { coalesceSyncJob } from "../../db/productSyncJobs.js";

export default async function handler({ topic, shop, body, deliveryId }) {
  const shopDomain = String(shop || "").trim();
  const webhookId = String(deliveryId || "").trim();
  if (!shopDomain || !webhookId) return;

  const duplicate = await isDuplicateDelivery(shopDomain, webhookId, topic);
  if (duplicate) {
    console.log("[variantsUpdate] duplicate delivery skipped", { shop: shopDomain, deliveryId: webhookId });
    return;
  }

  const productIdRaw = body?.product_id ?? body?.productId;
  if (productIdRaw == null) {
    console.log("[variantsUpdate] missing product_id; skip", { shop: shopDomain, deliveryId: webhookId });
    return;
  }
  const productId = BigInt(productIdRaw);

  const existing = await sql`
    SELECT job_id
    FROM product_sync_jobs
    WHERE shop_id = ${shopDomain}
      AND product_id = ${productId.toString()}::bigint
    LIMIT 1
  `;
  if (existing.length > 0) {
    console.log("[variantsUpdate] coalesced away", { shop: shopDomain, productId: productId.toString() });
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

