export function toVariantGridDto(payload) {
  const { variants, isStale } = payload;
  const variantsByProductId = {};
  const rows = [];
  const requestedProductIds = Array.isArray(variants?.requestedProductIds)
    ? variants.requestedProductIds
    : [];

  for (const productId of requestedProductIds) {
    variantsByProductId[productId] = [];
  }

  for (const row of variants.rows || []) {
    const productId = String(row?.productId || "").trim();
    const numericProductId = productId.match(/^\d+$/)
      ? productId
      : productId.match(/^gid:\/\/shopify\/Product\/(\d+)$/)?.[1] || "";
    const productGid = productId.startsWith("gid://shopify/Product/")
      ? productId
      : numericProductId
        ? `gid://shopify/Product/${numericProductId}`
        : productId;
    const variantId = String(row?.id || "").trim();
    const numericVariantId = variantId.match(/^\d+$/)
      ? variantId
      : variantId.match(/^gid:\/\/shopify\/ProductVariant\/(\d+)$/)?.[1] || "";
    const variantGid = variantId.startsWith("gid://shopify/ProductVariant/")
      ? variantId
      : numericVariantId
        ? `gid://shopify/ProductVariant/${numericVariantId}`
        : variantId;

    if (!productGid || !variantGid) continue;

    const variant = {
      id: variantGid,
      variantId: variantGid,
      productId: productGid,
      title: row?.title || "Default Title",
      sku: row?.sku || "",
      price: row?.price == null ? null : row.price.toString(),
      compareAtPrice: row?.compareAtPrice == null ? null : row.compareAtPrice.toString(),
      inventoryQuantity: row?.inventoryQuantity ?? null,
      position: row?.position ?? null,
      mirrorBatchId: row?.mirrorBatchId || null,
    };

    if (!variantsByProductId[productGid]) {
      variantsByProductId[productGid] = [];
    }
    variantsByProductId[productGid].push(variant);

    rows.push({
      ...variant,
      metafields: {},
      freshness: isStale ? "STALE" : "FRESH",
    });
  }

  return {
    success: true,
    variantsByProductId,
    rows,
    nextCursor: variants.nextCursor || null,
    isStale,
  };
}

export function toLegacyVariantMetafieldGridDto(payload) {
  const { variants, isStale } = payload;
  const grouped = new Map();

  for (const row of variants.rows || []) {
    const variantId = String(row?.variant_id || "").trim();
    if (!variantId) continue;
    if (!grouped.has(variantId)) {
      grouped.set(variantId, {
        id: variantId,
        variantId,
        productId: row?.product_id == null ? null : String(row.product_id),
        syncedAt: row?.synced_at || null,
        freshness: String(row?.freshness || "FRESH"),
        metafields: {},
      });
    }
    const composite = `${row.namespace}.${row.key}`;
    grouped.get(variantId).metafields[composite] = {
      value: row.value ?? null,
      pendingValue: row.pending_value ?? null,
      editStatus: row.edit_status ?? "SYNCED",
      syncedAt: row.synced_at ?? null,
      freshness: row.freshness ?? "FRESH",
    };
  }

  return {
    rows: Array.from(grouped.values()),
    nextCursor: variants.nextCursor,
    isStale,
  };
}
