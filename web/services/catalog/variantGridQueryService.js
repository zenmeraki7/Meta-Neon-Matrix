import { getForGrid, hasStaleVariantSync } from "../../db/variantMetafields.js";

export async function getVariantGrid(command) {
  const { shop, query } = command;
  const variants = await getForGrid(shop, query);
  const isStale = await hasStaleVariantSync(shop, 30);
  const grouped = new Map();

  for (const row of variants.rows || []) {
    const variantId = String(row?.variant_gid || "").trim();
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
      compareDigest: row.compare_digest ?? null,
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
