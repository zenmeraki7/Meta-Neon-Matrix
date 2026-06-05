export function toProductGridDto(payload) {
  const { listed, products, variants, metafields } = payload;

  const productById = new Map(products.map((product) => [String(product.id), product]));
  const metafieldByVariant = new Map();

  for (const mf of metafields) {
    const variantId = String(mf.variant_id);
    const mapKey = `${mf.namespace}.${mf.key}`;
    if (!metafieldByVariant.has(variantId)) metafieldByVariant.set(variantId, new Map());
    metafieldByVariant.get(variantId).set(mapKey, {
      value: mf.value ?? null,
      pendingValue: mf.pending_value ?? null,
      editStatus: mf.edit_status ?? "SYNCED",
      type: mf.type ?? null,
    });
  }

  const rows = variants
    .filter((variant) => productById.has(String(variant.product_id)))
    .map((variant) => {
      const product = productById.get(String(variant.product_id));
      const existing = metafieldByVariant.get(String(variant.id)) || new Map();
      const metafieldMap = {};

      for (const [key, value] of existing.entries()) {
        metafieldMap[key] = value;
      }

      return {
        variantId: String(variant.id),
        variantTitle: variant.title,
        sku: variant.sku,
        price: variant.price,
        inventoryQuantity: variant.inventory_quantity,
        position: variant.position,
        optionValues: Array.isArray(variant.option_values) ? variant.option_values : [],
        productId: String(product.id),
        productTitle: product.title,
        productHandle: product.handle,
        productStatus: product.status,
        vendor: product.vendor,
        productType: product.productType,
        tags: Array.isArray(product.tags) ? product.tags : [],
        metafields: metafieldMap,
      };
    });

  return {
    rows,
    nextCursor: listed.nextCursor || null,
    total: Number(listed.total || 0),
  };
}
