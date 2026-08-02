import { prisma } from "../config/database.js";
import { requireVariantGid } from "../utils/shopifyVariantGid.js";

const SYNC_SAFE_STATUSES = Object.freeze(["SYNCED", "WRITTEN"]);

/**
 * Sync-safe mirror upsert. This must never overwrite staged/failed working states.
 * Only rows currently in SYNCED or WRITTEN are eligible for value overwrite.
 *
 * @param {string} shop
 * @param {Array<{
 *   variantGid: string,
 *   definitionId?: string|null,
 *   namespace: string,
 *   key: string,
 *   type?: string|null,
 *   value?: string|null,
 *   compareDigest?: string|null,
 *   shopifyMetafieldId?: string|null,
 *   shopifyVersion?: string|number|bigint|null,
 *   sourceEntityUpdatedAt?: string|Date|null
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
      const variantGid = requireVariantGid(row.variantGid);
      const namespace = String(row.namespace || "").trim();
      const key = String(row.key || "").trim();
      const type = row.type == null ? null : String(row.type);
      const value = row.value == null ? null : String(row.value);
      const compareDigest = row.compareDigest == null ? null : String(row.compareDigest);
      const shopifyVersion =
        row.shopifyVersion == null
          ? (() => {
              const parsedDate = row.sourceEntityUpdatedAt ? new Date(row.sourceEntityUpdatedAt) : null;
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
          AND variant_gid = ${variantGid}
          AND namespace = ${namespace}
          AND key = ${key}
          AND (${shopifyVersion}::bigint = 0 OR COALESCE(shopify_version, 0) < ${shopifyVersion}::bigint)
          AND edit_status = ANY(${SYNC_SAFE_STATUSES}::text[])
        RETURNING variant_gid
      `;
      if (changed.length > 0) {
        updated += changed.length;
        continue;
      }

      const created = await tx.$queryRaw`
        INSERT INTO variant_metafields (
          shop_id,
          variant_gid,
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
          ${variantGid},
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
        ON CONFLICT (shop_id, variant_gid, namespace, key)
        DO NOTHING
        RETURNING variant_gid
      `;
      inserted += created.length;
    }
  });

  return { updated, inserted };
}

/**
 * Gets current confirmed value for one variant metafield cell.
 * @param {string} shop
 * @param {string} variantGid
 * @param {string} namespace
 * @param {string} key
 * @returns {Promise<string|null>}
 */
export async function getCurrentValue(shop, variantGid, namespace, key) {
  const resolvedShop = String(shop || "").trim();
  const resolvedNamespace = String(namespace || "").trim();
  const resolvedKey = String(key || "").trim();
  if (!resolvedShop || !resolvedNamespace || !resolvedKey) return null;
  const resolvedVariantGid = requireVariantGid(variantGid);
  const rows = await prisma.$queryRaw`
    SELECT value
    FROM variant_metafields
    WHERE shop_id = ${resolvedShop}
      AND variant_gid = ${resolvedVariantGid}
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
 * @param {Array<string>} variantGids
 * @returns {Promise<Array<object>>}
 */
export async function getMetafieldsForVariants(shop, variantGids) {
  const resolvedShop = String(shop || "").trim();
  if (!resolvedShop) throw new Error("getMetafieldsForVariants requires shop");
  if (!Array.isArray(variantGids) || variantGids.length === 0) return [];
  const gids = variantGids.map((gid) => requireVariantGid(gid));
  return prisma.$queryRaw`
    SELECT
      variant_id,
      variant_gid,
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
      AND variant_gid = ANY(${gids}::text[])
  `;
}

/**
 * Grid datasource for variant metafields (Neon mirror only).
 * @param {string} shop
 * @param {{ productIds?: string|string[]|number[]|bigint[], cursor?: string|number, limit?: string|number }} filters
 * @returns {Promise<{rows:Array<object>,nextCursor:string|null}>}
 */
export async function getForGrid(shop, filters = {}) {
  const resolvedShop = String(shop || "").trim();
  if (!resolvedShop) throw new Error("getForGrid requires shop");

  const rawLimit = Number.parseInt(String(filters?.limit ?? 50), 10);
  const limit = Math.max(1, Math.min(200, Number.isFinite(rawLimit) ? rawLimit : 50));
  const cursor = filters?.cursor == null ? null : String(filters.cursor).trim();
  const cursorId = cursor ? BigInt(cursor).toString() : null;

  const rawProductIds = Array.isArray(filters?.productIds)
    ? filters.productIds
    : filters?.productIds == null
      ? []
      : String(filters.productIds)
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
  const productIds = rawProductIds.map((id) => BigInt(id).toString());

  const rows = await prisma.$queryRaw`
    SELECT
      vm.id,
      vm.variant_id,
      vm.variant_gid,
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
    FROM variant_metafields vm
    JOIN variants v
      ON v.shop_id = vm.shop_id
     AND v.id = vm.variant_id
    WHERE vm.shop_id = ${resolvedShop}
      AND (${cursorId}::bigint IS NULL OR vm.id > ${cursorId}::bigint)
      AND (${productIds}::bigint[] = '{}'::bigint[] OR v.product_id = ANY(${productIds}::bigint[]))
    ORDER BY vm.id ASC
    LIMIT ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? String(page[page.length - 1]?.id || "") : null;

  return { rows: page, nextCursor };
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
  value,
  compareDigest = null,
  shopifyMetafieldId = null,
}) {
  const resolvedId = String(id || "").trim();
  if (!resolvedId) throw new Error("updateConfirmedValueGuarded requires id");

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
      AND edit_status = ANY(${SYNC_SAFE_STATUSES}::text[])
    RETURNING id
  `;
  return rows.length;
}

export const VARIANT_METAFIELD_SYNC_SAFE_STATUSES = SYNC_SAFE_STATUSES;
