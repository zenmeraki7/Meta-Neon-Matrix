const VARIANT_GID_PATTERN = /^gid:\/\/shopify\/ProductVariant\/([1-9]\d*)$/;

export function requireVariantGid(value, fieldName = "variantGid") {
  const gid = String(value || "").trim();
  if (!VARIANT_GID_PATTERN.test(gid)) {
    throw new Error(`${fieldName} must be a canonical Shopify ProductVariant GID`);
  }
  return gid;
}

// Compatibility conversion for values read from verified legacy bigint columns.
// This uses decimal strings only and never passes a Shopify ID through Number.
export function variantGidFromVerifiedLegacyId(value) {
  const decimal = typeof value === "bigint" ? value.toString() : String(value || "").trim();
  if (!/^[1-9]\d*$/.test(decimal)) {
    throw new Error("legacy variant ID is not a positive Shopify legacy ID");
  }
  return `gid://shopify/ProductVariant/${decimal}`;
}

export function normalizeVariantGid(value, { allowVerifiedLegacyId = false } = {}) {
  const candidate = String(value || "").trim();
  if (VARIANT_GID_PATTERN.test(candidate)) return candidate;
  if (allowVerifiedLegacyId) return variantGidFromVerifiedLegacyId(value);
  return requireVariantGid(candidate);
}

export const SHOPIFY_VARIANT_GID_PATTERN = VARIANT_GID_PATTERN;
