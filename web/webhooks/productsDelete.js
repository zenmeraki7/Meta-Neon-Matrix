import { softDeleteProduct } from "../../db/products.js";
import { isDuplicateDelivery } from "../../db/webhookDeliveries.js";

/**
 * Handles PRODUCTS_DELETE webhook.
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
    console.log("[productsDelete] duplicate delivery skipped", { shop: shopDomain, deliveryId: webhookId });
    return;
  }

  const productId = BigInt(body?.id);
  await softDeleteProduct(shopDomain, productId, "SHOPIFY_WEBHOOK_DELETE");
}

