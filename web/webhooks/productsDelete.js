import { softDeleteProduct } from "../../db/products.js";
import { isDuplicateDelivery } from "../../db/webhookDeliveries.js";

/**
 * Handles PRODUCTS_DELETE webhook.
 * @param {{ topic: string, shop: string, body: object, deliveryId: string }} payload
 * @returns {Promise<void>}
 * @throws {Error}
 */
export default async function handler({ topic, shop, body, deliveryId }) {
  const shopId = String(shop || "").trim();
  const webhookId = String(deliveryId || "").trim();
  if (!shopId || !webhookId) return;

  const duplicate = await isDuplicateDelivery(shopId, webhookId, topic);
  if (duplicate) {
    console.log("[productsDelete] duplicate delivery skipped", { shop: shopId, deliveryId: webhookId });
    return;
  }

  const productId = BigInt(body?.id);
  await softDeleteProduct(shopId, productId, "SHOPIFY_WEBHOOK_DELETE");
}

