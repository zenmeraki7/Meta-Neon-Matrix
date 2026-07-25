/** @typedef {import("../types/identity.js").StoreId} StoreId */
/** @typedef {import("../types/identity.js").ShopDomain} ShopDomain */
/** @typedef {import("../types/identity.js").MirrorBatchId} MirrorBatchId */
/** @typedef {import("../types/identity.js").ProductGid} ProductGid */
/** @typedef {import("../types/identity.js").VariantGid} VariantGid */

function requiredString(value, fieldName) {
  const resolved = String(value || "").trim();
  if (!resolved) {
    const error = new Error(`${fieldName} is required`);
    error.code = "IDENTITY_REQUIRED";
    throw error;
  }
  return resolved;
}

export const SHOP_DOMAIN_PATTERN =
  /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

/** @returns {ShopDomain} */
export function requireShopDomain(value) {
  const shopDomain = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SHOP_DOMAIN_PATTERN.test(shopDomain)) {
    const error = new Error("INVALID_SHOP_DOMAIN");
    error.code = "INVALID_SHOP_DOMAIN";
    throw error;
  }
  return /** @type {ShopDomain} */ (shopDomain);
}

/** @returns {StoreId} */
export function requireStoreId(value) {
  const storeId = typeof value === "string" ? value.trim() : "";
  if (!storeId || storeId.toLowerCase().endsWith(".myshopify.com")) {
    const error = new Error("INVALID_STORE_ID");
    error.code = "INVALID_STORE_ID";
    throw error;
  }
  return /** @type {StoreId} */ (storeId);
}

export const asShopDomain = requireShopDomain;
export const asStoreId = requireStoreId;

/** @returns {MirrorBatchId} */
export function asMirrorBatchId(value) {
  const mirrorBatchId = requiredString(value, "mirrorBatchId");
  if (/\.myshopify\.com\.?$/i.test(mirrorBatchId)) {
    const error = new Error("mirrorBatchId cannot contain a Shopify domain");
    error.code = "MIRROR_BATCH_ID_IS_SHOP_DOMAIN";
    throw error;
  }
  return /** @type {MirrorBatchId} */ (mirrorBatchId);
}

function asShopifyGid(value, resourceType, fieldName) {
  const gid = requiredString(value, fieldName);
  const expression = new RegExp(`^gid://shopify/${resourceType}/[1-9][0-9]*$`);
  if (!expression.test(gid)) {
    const error = new Error(`${fieldName} must be a Shopify ${resourceType} GID`);
    error.code = "SHOPIFY_GID_INVALID";
    throw error;
  }
  return gid;
}

/** @returns {ProductGid} */
export function asProductGid(value) {
  return /** @type {ProductGid} */ (asShopifyGid(value, "Product", "productGid"));
}

/** @returns {VariantGid} */
export function asVariantGid(value) {
  return /** @type {VariantGid} */ (asShopifyGid(value, "ProductVariant", "variantGid"));
}
