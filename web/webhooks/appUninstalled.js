import { deactivateShop } from "../../db/shops.js";

/**
 * APP_UNINSTALLED webhook handler.
 * @param {string} _topic
 * @param {string} shop
 * @param {object} payload
 * @returns {Promise<void>}
 * @throws {Error}
 */
export default async function appUninstalled(_topic, shop, payload) {
  try {
    const domainFromPayload = String(payload?.domain || "").trim();
    const resolvedShop = domainFromPayload || String(shop || "").trim();
    if (!resolvedShop) {
      throw new Error("APP_UNINSTALLED payload missing shop domain");
    }

    const row = await deactivateShop(resolvedShop);
    console.log("[APP_UNINSTALLED] shop deactivated", {
      shop: resolvedShop,
      deactivated: Boolean(row),
    });
  } catch (error) {
    console.error("[APP_UNINSTALLED] failed to deactivate shop", {
      shop: String(payload?.domain || shop || ""),
      message: error?.message || String(error),
    });
  }
}

