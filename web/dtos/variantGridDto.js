export function toVariantGridDto(payload) {
  const { variants, isStale } = payload;
  const grouped = new Map();

  function mergeFreshness(current, next) {
    if (current === "STALE" || next === "STALE") return "STALE";
    return next || current || "FRESH";
  }

  function latestSyncedAt(current, next) {
    if (!current) return next || null;
    if (!next) return current;
    return new Date(next).getTime() > new Date(current).getTime() ? next : current;
  }

  for (const row of variants.rows || []) {
    const variantId = String(row?.variant_id || "").trim();
    if (!variantId) {
      const error = new Error("VARIANT_GRID_ROW_MISSING_VARIANT_ID");
      error.code = "INTERNAL_DATA_CORRUPTION";
      throw error;
    }
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
    const group = grouped.get(variantId);
    group.freshness = mergeFreshness(group.freshness, String(row?.freshness || "FRESH"));
    group.syncedAt = latestSyncedAt(group.syncedAt, row?.synced_at || null);

    const namespace = String(row?.namespace || "").trim();
    const key = String(row?.key || "").trim();
    if (!namespace && !key) continue;
    if (!namespace || !key) {
      const error = new Error("VARIANT_GRID_METAFIELD_KEY_MALFORMED");
      error.code = "INTERNAL_DATA_CORRUPTION";
      throw error;
    }
    const composite = `${namespace}.${key}`;
    group.metafields[composite] = {
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
    total: Number(variants.total || 0),
    isStale,
  };
}
