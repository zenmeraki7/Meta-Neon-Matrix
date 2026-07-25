import sql from "./client.js";

/**
 * Inserts delivery id for dedupe; returns true when duplicate.
 * @param {string} shopDomain
 * @param {string} deliveryId
 * @param {string} [topic="UNKNOWN"]
 * @returns {Promise<boolean>}
 * @throws {Error}
 */
export async function isDuplicateDelivery(shopDomain, deliveryId, topic = "UNKNOWN") {
  const resolvedShopDomain = String(shopDomain || "").trim();
  const resolvedDeliveryId = String(deliveryId || "").trim();
  const resolvedTopic = String(topic || "UNKNOWN").trim() || "UNKNOWN";
  if (!resolvedShopDomain) throw new Error("isDuplicateDelivery requires shopDomain");
  if (!resolvedDeliveryId) throw new Error("isDuplicateDelivery requires deliveryId");

  const rows = await sql`
    INSERT INTO webhook_deliveries (shopify_delivery_id, shop_id, topic)
    VALUES (${resolvedDeliveryId}, ${resolvedShopDomain}, ${resolvedTopic})
    ON CONFLICT (shopify_delivery_id, shop_id) DO NOTHING
    RETURNING shopify_delivery_id
  `;
  return rows.length === 0;
}

