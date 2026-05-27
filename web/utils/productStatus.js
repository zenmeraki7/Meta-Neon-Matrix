const SHOPIFY_PRODUCT_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  DRAFT: "DRAFT",
  ARCHIVED: "ARCHIVED",
  UNKNOWN: "UNKNOWN",
});

export function normalizeProductStatus(status) {
  const normalized = String(status || "").trim().toUpperCase();
  if (
    normalized === SHOPIFY_PRODUCT_STATUS.ACTIVE ||
    normalized === SHOPIFY_PRODUCT_STATUS.DRAFT ||
    normalized === SHOPIFY_PRODUCT_STATUS.ARCHIVED
  ) {
    return normalized;
  }

  return SHOPIFY_PRODUCT_STATUS.UNKNOWN;
}

export { SHOPIFY_PRODUCT_STATUS };
