function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function normalizeShopifyGid(value, resourceType) {
  const raw = safeString(value, "").trim();
  if (!raw) return null;
  if (raw.startsWith(`gid://shopify/${resourceType}/`)) return raw;
  if (/^[1-9][0-9]*$/.test(raw)) return `gid://shopify/${resourceType}/${raw}`;
  const error = new Error(`INVALID_${resourceType.toUpperCase()}_IDENTITY`);
  error.code = "INVALID_PRODUCT_IDENTITY";
  throw error;
}

function serializeVariantIdentity(variant, { shopDomain, mirrorBatchId, productId }) {
  const variantId = normalizeShopifyGid(variant?.variantId ?? variant?.id, "ProductVariant");
  if (!variantId) return null;
  return {
    ...variant,
    id: variantId,
    variantId,
    productId,
    rowKey: `${shopDomain}:${mirrorBatchId}:${variantId}`,
  };
}

function serializeProductIdentity(product, { shopDomain, mirrorBatchId }) {
  const productId = normalizeShopifyGid(product?.productId ?? product?.id, "Product");
  if (!productId) return null;
  const variants = Array.isArray(product?.variants)
    ? product.variants
      .map((variant) => serializeVariantIdentity(variant, { shopDomain, mirrorBatchId, productId }))
      .filter(Boolean)
    : undefined;
  return {
    ...product,
    id: productId,
    productId,
    rowKey: `${shopDomain}:${mirrorBatchId}:${productId}`,
    ...(variants ? { variants } : {}),
  };
}

export function toProductQueryResponseDto(result) {
  const shopDomain = safeString(result?.shopDomain, "").trim().toLowerCase();
  const mirrorBatchId = safeString(result?.mirrorBatchId, "").trim();
  const products = safeArray(result?.products)
    .map((product) => serializeProductIdentity(product, { shopDomain, mirrorBatchId }))
    .filter(Boolean);
  return {
    success: true,
    data: {
      ...(result || {}),
      products,
    },
  };
}

export function toBulkEditStatusDto(result) {
  return {
    success: true,
    data: result || {},
  };
}

export function toProductOptionListDto(result) {
  const data = safeArray(result)
    .map((item) => {
      if (item && typeof item === "object") {
        const value = safeString(
          item.value ?? item.title ?? item.name ?? item.label ?? item.id,
          "",
        );
        const label = safeString(
          item.label ?? item.title ?? item.name ?? item.value ?? item.id,
          value,
        );

        return value ? { value, label } : null;
      }

      const value = safeString(item, "");
      return value ? { value, label: value } : null;
    })
    .filter(Boolean);

  return {
    success: true,
    data,
    meta: { count: data.length },
  };
}

export function toFilterRegistryDto(result) {
  return {
    success: true,
    data: {
      versions: result?.versions || null,
      fields: safeArray(result?.fields),
    },
  };
}
