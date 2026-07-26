const SHOP_DOMAIN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/;

/**
 * Validates and canonicalizes a Shopify myshopify.com domain string.
 * Returns lowercase canonical domain or null if invalid/missing.
 */
export function normalizeShopDomain(value) {
  if (typeof value !== "string") {
    return null;
  }

  const shop = value.trim().toLowerCase();

  if (!SHOP_DOMAIN_PATTERN.test(shop)) {
    return null;
  }

  return shop;
}
