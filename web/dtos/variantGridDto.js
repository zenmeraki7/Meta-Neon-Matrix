export function toVariantGridDto(payload) {
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
