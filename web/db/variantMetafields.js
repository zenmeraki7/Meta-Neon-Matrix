import { prisma } from "../config/database.js";

const SYNC_SAFE_STATUSES = Object.freeze(["SYNCED", "WRITTEN"]);

/**
 * Sync-safe mirror upsert. This must never overwrite staged/failed working states.
 * Only rows currently in SYNCED or WRITTEN are eligible for value overwrite.
 *
 * @param {string} shop
 * @param {Array<{
 *   variantId: string|number|bigint,
 *   definitionId?: string|null,
 *   namespace: string,
 *   key: string,
 *   type?: string|null,
 *   value?: string|null,
 *   compareDigest?: string|null,
 *   shopifyMetafieldId?: string|null,
 *   shopifyVersion?: string|number|bigint|null,
 *   sourceUpdatedAt?: string|Date|null
 * }>} rows
 * @returns {Promise<{updated:number, inserted:number}>}
 */
export async function upsertFromSync(shop, rows) {
  const resolvedShop = String(shop || "").trim();
  if (!resolvedShop) throw new Error("upsertFromSync requires shop");
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { updated: 0, inserted: 0 };

  let updated = 0;
  let inserted = 0;

  await prisma.$transaction(async (tx) => {
    for (const row of list) {
      const variantId = BigInt(row.variantId).toString();
      const namespace = String(row.namespace || "").trim();
      const key = String(row.key || "").trim();
      const type = row.type == null ? null : String(row.type);
      const value = row.value == null ? null : String(row.value);
      const compareDigest = row.compareDigest == null ? null : String(row.compareDigest);
      const shopifyVersion =
        row.shopifyVersion == null
          ? (() => {
              const parsedDate = row.sourceUpdatedAt ? new Date(row.sourceUpdatedAt) : null;
              const ms = parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.getTime() : 0;
              return BigInt(ms > 0 ? ms : 0).toString();
            })()
          : BigInt(row.shopifyVersion).toString();
      const definitionId = row.definitionId == null ? null : String(row.definitionId);
      const shopifyMetafieldId =
        row.shopifyMetafieldId == null ? null : String(row.shopifyMetafieldId);

      if (!namespace || !key) {
        throw new Error("upsertFromSync row requires namespace and key");
      }

      const changed = await tx.$queryRaw`
        UPDATE variant_metafields
        SET
          definition_id = COALESCE(${definitionId}::uuid, definition_id),
          type = COALESCE(${type}, type),
          value = ${value},
          compare_digest = ${compareDigest},
          shopify_version = CASE
            WHEN ${shopifyVersion}::bigint > 0 THEN ${shopifyVersion}::bigint
            ELSE shopify_version
          END,
          shopify_metafield_id = COALESCE(${shopifyMetafieldId}, shopify_metafield_id),
          pending_value = NULL,
          edit_status = 'SYNCED',
          last_synced_at = now(),
          updated_at = now()
        WHERE shop_id = ${resolvedShop}
          AND variant_id = ${variantId}::bigint
          AND namespace = ${namespace}
          AND key = ${key}
          AND (${shopifyVersion}::bigint = 0 OR COALESCE(shopify_version, 0) < ${shopifyVersion}::bigint)
          AND edit_status = ANY(${SYNC_SAFE_STATUSES}::text[])
        RETURNING variant_id
      `;
      if (changed.length > 0) {
        updated += changed.length;
        continue;
      }

      const created = await tx.$queryRaw`
        INSERT INTO variant_metafields (
          shop_id,
          variant_id,
          definition_id,
          namespace,
          key,
          type,
          value,
          pending_value,
          compare_digest,
          shopify_version,
          shopify_metafield_id,
          edit_status,
          last_synced_at,
          updated_at
        )
        VALUES (
          ${resolvedShop},
          ${variantId}::bigint,
          ${definitionId}::uuid,
          ${namespace},
          ${key},
          ${type},
          ${value},
          NULL,
          ${compareDigest},
          ${shopifyVersion}::bigint,
          ${shopifyMetafieldId},
          'SYNCED',
          now(),
          now()
        )
        ON CONFLICT (shop_id, variant_id, namespace, key)
        DO NOTHING
        RETURNING variant_id
      `;
      inserted += created.length;
    }
  });

  return { updated, inserted };
}

/**
 * Gets current confirmed value for one variant metafield cell.
 * @param {string} shop
 * @param {string|number|bigint} variantId
 * @param {string} namespace
 * @param {string} key
 * @returns {Promise<string|null>}
 */
export async function getCurrentValue(shop, variantId, namespace, key) {
  const resolvedShop = String(shop || "").trim();
  const resolvedNamespace = String(namespace || "").trim();
  const resolvedKey = String(key || "").trim();
  if (!resolvedShop || !resolvedNamespace || !resolvedKey) return null;
  const resolvedVariantId = BigInt(variantId).toString();
  const rows = await prisma.$queryRaw`
    SELECT value
    FROM variant_metafields
    WHERE shop_id = ${resolvedShop}
      AND variant_id = ${resolvedVariantId}::bigint
      AND namespace = ${resolvedNamespace}
      AND key = ${resolvedKey}
    LIMIT 1
  `;
  return rows[0]?.value ?? null;
}

export const getPendingValue = getCurrentValue;

/**
 * Gets variant metafield rows for variant ids scoped to shop.
 * @param {string} shop
 * @param {Array<bigint>} variantIds
 * @returns {Promise<Array<object>>}
 */
export async function getMetafieldsForVariants(shop, variantIds) {
  const resolvedShop = String(shop || "").trim();
  if (!resolvedShop) throw new Error("getMetafieldsForVariants requires shop");
  if (!Array.isArray(variantIds) || variantIds.length === 0) return [];
  const ids = variantIds
    .map((id) => String(id ?? "").trim())
    .filter((id) => /^\d+$/.test(id));
  if (!ids.length) return [];
  return prisma.$queryRaw`
    SELECT
      variant_id,
      namespace,
      key,
      value,
      pending_value,
      edit_status,
      type,
      compare_digest,
      shopify_metafield_id
    FROM variant_metafields
    WHERE shop_id = ${resolvedShop}
      AND variant_id = ANY(${ids}::bigint[])
  `;
}

/**
 * Grid datasource for variants and their metafields (Neon mirror only).
 * Pagination is variant-boundary based: limit applies to variants, not metafield rows.
 * @param {string} shop
 * @param {{ productIds?: string|string[]|number[]|bigint[], cursor?: string|number, limit?: string|number }} filters
 * @returns {Promise<{rows:Array<object>,nextCursor:string|null,total:number}>}
 */
export async function getForGrid(shop, filters = {}) {
  const resolvedShop = String(shop || "").trim();
  if (!resolvedShop) throw new Error("getForGrid requires shop");

  const rawLimit = Number.parseInt(String(filters?.limit ?? 50), 10);
  const limit = Math.max(1, Math.min(200, Number.isFinite(rawLimit) ? rawLimit : 50));
  const cursor = filters?.cursor == null ? null : String(filters.cursor).trim();
  const cursorId = cursor && /^\d+$/.test(cursor) ? cursor : null;

  const rawProductIds = Array.isArray(filters?.productIds)
    ? filters.productIds
    : filters?.productIds == null
      ? []
      : String(filters.productIds)
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
  const productIds = rawProductIds
    .map((id) => String(id ?? "").trim())
    .filter((id) => /^\d+$/.test(id));

  const totalRows = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS count
    FROM variants v
    WHERE v.shop_id = ${resolvedShop}
      AND v.is_deleted = false
      AND (${productIds}::bigint[] = '{}'::bigint[] OR v.product_id = ANY(${productIds}::bigint[]))
  `;

  const variantPage = await prisma.$queryRaw`
    SELECT v.id
    FROM variants v
    WHERE v.shop_id = ${resolvedShop}
      AND v.is_deleted = false
      AND (${cursorId}::bigint IS NULL OR v.id > ${cursorId}::bigint)
      AND (${productIds}::bigint[] = '{}'::bigint[] OR v.product_id = ANY(${productIds}::bigint[]))
    ORDER BY v.id ASC
    LIMIT ${limit + 1}
  `;

  const hasMore = variantPage.length > limit;
  const pageVariants = hasMore ? variantPage.slice(0, limit) : variantPage;
  const variantIds = pageVariants
    .map((row) => String(row?.id ?? "").trim())
    .filter((id) => /^\d+$/.test(id));

  if (!variantIds.length) {
    return {
      rows: [],
      nextCursor: null,
      total: Number(totalRows?.[0]?.count || 0),
    };
  }

  const rows = await prisma.$queryRaw`
    SELECT
      vm.id,
      v.id AS variant_id,
      v.product_id,
      vm.namespace,
      vm.key,
      vm.type,
      vm.value,
      vm.pending_value,
      vm.compare_digest,
      vm.edit_status,
      vm.shopify_metafield_id,
      COALESCE(vm.last_synced_at, v.synced_at) AS synced_at,
      CASE
        WHEN COALESCE(vm.last_synced_at, v.synced_at) < now() - interval '1 hour' THEN 'STALE'
        ELSE 'FRESH'
      END AS freshness
    FROM variants v
    LEFT JOIN variant_metafields vm
      ON vm.shop_id = v.shop_id
     AND vm.variant_id = v.id
    WHERE v.shop_id = ${resolvedShop}
      AND v.id = ANY(${variantIds}::bigint[])
    ORDER BY v.id ASC, vm.namespace ASC NULLS LAST, vm.key ASC NULLS LAST, vm.id ASC NULLS LAST
  `;

  const nextCursor = hasMore ? String(pageVariants[pageVariants.length - 1]?.id || "") : null;

  return {
    rows,
    nextCursor,
    total: Number(totalRows?.[0]?.count || 0),
  };
}

/**
 * Returns true if at least one variant row is stale for the shop.
 * Stale definition: synced_at older than threshold minutes.
 *
 * @param {string} shop
 * @param {number} [thresholdMinutes=30]
 * @returns {Promise<boolean>}
 */
export async function hasStaleVariantSync(shop, thresholdMinutes = 30) {
  const resolvedShop = String(shop || "").trim();
  if (!resolvedShop) throw new Error("hasStaleVariantSync requires shop");
  const threshold = Number.isFinite(Number(thresholdMinutes))
    ? Math.max(1, Math.floor(Number(thresholdMinutes)))
    : 30;

  const rows = await prisma.$queryRaw`
    SELECT id
    FROM variants
    WHERE shop_id = ${resolvedShop}
      AND synced_at < now() - (${threshold}::text || ' minutes')::interval
    LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * Guarded confirmed-value update for sync/reconciliation paths.
 * Never overwrites staged/working/error rows.
 *
 * @param {{ id: string, value: string|null, compareDigest?: string|null, shopifyMetafieldId?: string|null }} input
 * @returns {Promise<number>}
 */
export async function updateConfirmedValueGuarded({
  id,
  shop,
  value,
  compareDigest = null,
  shopifyMetafieldId = null,
}) {
  const resolvedId = String(id || "").trim();
  const resolvedShop = String(shop || "").trim();
  if (!resolvedId || !resolvedShop) {
    throw new Error("updateConfirmedValueGuarded requires id and shop");
  }

  const rows = await prisma.$queryRaw`
    UPDATE variant_metafields
    SET
      value = ${value == null ? null : String(value)},
      compare_digest = ${compareDigest == null ? null : String(compareDigest)},
      shopify_metafield_id = COALESCE(${shopifyMetafieldId == null ? null : String(shopifyMetafieldId)}, shopify_metafield_id),
      pending_value = NULL,
      edit_status = 'SYNCED',
      last_synced_at = now(),
      updated_at = now()
    WHERE id = ${resolvedId}::uuid
      AND shop_id = ${resolvedShop}
      AND edit_status = ANY(${SYNC_SAFE_STATUSES}::text[])
    RETURNING id
  `;
  return rows.length;
}

export const VARIANT_METAFIELD_SYNC_SAFE_STATUSES = SYNC_SAFE_STATUSES;
