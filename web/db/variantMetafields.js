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
 *   shopifyMetafieldId?: string|null
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
          shopify_metafield_id = COALESCE(${shopifyMetafieldId}, shopify_metafield_id),
          pending_value = NULL,
          edit_status = 'SYNCED',
          last_synced_at = now(),
          updated_at = now()
        WHERE shop_id = ${resolvedShop}
          AND variant_id = ${variantId}::bigint
          AND namespace = ${namespace}
          AND key = ${key}
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
  const ids = variantIds.map((id) => BigInt(id).toString());
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
