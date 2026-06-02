import sql from "./client.js";
import { BATCH_SIZE } from "../workers/fullSync.js";

function chunk(list, size) {
  const items = Array.isArray(list) ? list : [];
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64").toString("utf8"));
    if (!parsed?.updatedAt || parsed?.id === undefined || parsed?.id === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Upserts products into mirror.
 * @param {string} shopId
 * @param {string} mirrorBatchId
 * @param {Array<object>} products
 * @returns {Promise<number>}
 * @throws {Error}
 */
export async function upsertProducts(shopId, mirrorBatchId, products) {
  const resolvedShopId = String(shopId || "").trim();
  const resolvedBatchId = String(mirrorBatchId || "").trim();
  if (!resolvedShopId) throw new Error("upsertProducts requires shopId");
  if (!resolvedBatchId) throw new Error("upsertProducts requires mirrorBatchId");
  if (!Array.isArray(products) || products.length === 0) return 0;

  let total = 0;
  for (const group of chunk(products, Number(BATCH_SIZE || 100))) {
    for (const product of group) {
      // eslint-disable-next-line no-await-in-loop
      await sql`
        INSERT INTO products (
          id, shop_id, mirror_batch_id, title, handle, status, vendor, product_type, tags,
          shopify_created_at, shopify_updated_at, synced_at, is_deleted, deleted_at, delete_source
        ) VALUES (
          ${product.id.toString()}::bigint,
          ${resolvedShopId},
          ${resolvedBatchId}::uuid,
          ${String(product.title || "")},
          ${String(product.handle || "")},
          ${String(product.status || "")},
          ${product.vendor ?? null},
          ${product.productType ?? null},
          ${JSON.stringify(Array.isArray(product.tags) ? product.tags : [])}::jsonb,
          ${product.shopifyCreatedAt || null},
          ${product.shopifyUpdatedAt || null},
          now(),
          false,
          null,
          null
        )
        ON CONFLICT (id, shop_id)
        DO UPDATE SET
          mirror_batch_id = EXCLUDED.mirror_batch_id,
          title = EXCLUDED.title,
          handle = EXCLUDED.handle,
          status = EXCLUDED.status,
          vendor = EXCLUDED.vendor,
          product_type = EXCLUDED.product_type,
          tags = EXCLUDED.tags,
          shopify_created_at = EXCLUDED.shopify_created_at,
          shopify_updated_at = EXCLUDED.shopify_updated_at,
          synced_at = now(),
          is_deleted = false,
          deleted_at = null,
          delete_source = null
        WHERE products.shopify_updated_at IS NULL
           OR EXCLUDED.shopify_updated_at IS NULL
           OR EXCLUDED.shopify_updated_at >= products.shopify_updated_at
      `;
      total += 1;
    }
  }
  return total;
}

/**
 * Upserts variants into mirror.
 * @param {string} shopId
 * @param {string} mirrorBatchId
 * @param {Array<object>} variants
 * @returns {Promise<number>}
 * @throws {Error}
 */
export async function upsertVariants(shopId, mirrorBatchId, variants) {
  const resolvedShopId = String(shopId || "").trim();
  const resolvedBatchId = String(mirrorBatchId || "").trim();
  if (!resolvedShopId) throw new Error("upsertVariants requires shopId");
  if (!resolvedBatchId) throw new Error("upsertVariants requires mirrorBatchId");
  if (!Array.isArray(variants) || variants.length === 0) return 0;

  let total = 0;
  for (const group of chunk(variants, Number(BATCH_SIZE || 100))) {
    for (const variant of group) {
      // eslint-disable-next-line no-await-in-loop
      await sql`
        INSERT INTO variants (
          id, shop_id, product_id, mirror_batch_id, title, sku, price, inventory_quantity,
          position, option_values, shopify_created_at, shopify_updated_at, synced_at,
          is_deleted, deleted_at, delete_source
        ) VALUES (
          ${variant.id.toString()}::bigint,
          ${resolvedShopId},
          ${variant.productId.toString()}::bigint,
          ${resolvedBatchId}::uuid,
          ${String(variant.title || "")},
          ${variant.sku ?? null},
          ${String(variant.price || "0")},
          ${Number(variant.inventoryQuantity || 0)},
          ${Number(variant.position || 0)},
          ${JSON.stringify(Array.isArray(variant.optionValues) ? variant.optionValues : [])}::jsonb,
          ${variant.shopifyCreatedAt || null},
          ${variant.shopifyUpdatedAt || null},
          now(),
          false,
          null,
          null
        )
        ON CONFLICT (id, shop_id)
        DO UPDATE SET
          product_id = EXCLUDED.product_id,
          mirror_batch_id = EXCLUDED.mirror_batch_id,
          title = EXCLUDED.title,
          sku = EXCLUDED.sku,
          price = EXCLUDED.price,
          inventory_quantity = EXCLUDED.inventory_quantity,
          position = EXCLUDED.position,
          option_values = EXCLUDED.option_values,
          shopify_created_at = EXCLUDED.shopify_created_at,
          shopify_updated_at = EXCLUDED.shopify_updated_at,
          synced_at = now(),
          is_deleted = false,
          deleted_at = null,
          delete_source = null
        WHERE variants.shopify_updated_at IS NULL
           OR EXCLUDED.shopify_updated_at IS NULL
           OR EXCLUDED.shopify_updated_at >= variants.shopify_updated_at
      `;
      total += 1;
    }
  }
  return total;
}

/**
 * Soft deletes product and all its variants.
 * @param {string} shopId
 * @param {bigint|string|number} productId
 * @param {string} source
 * @returns {Promise<void>}
 * @throws {Error}
 */
export async function softDeleteProduct(shopId, productId, source) {
  const resolvedShopId = String(shopId || "").trim();
  const resolvedProductId = BigInt(productId).toString();
  const resolvedSource = String(source || "").trim();
  if (!resolvedShopId) throw new Error("softDeleteProduct requires shopId");
  if (!resolvedSource) throw new Error("softDeleteProduct requires source");

  await sql.transaction((txn) => [
    txn`
      UPDATE products
      SET
        is_deleted = true,
        deleted_at = now(),
        delete_source = ${resolvedSource},
        synced_at = now()
      WHERE shop_id = ${resolvedShopId}
        AND id = ${resolvedProductId}::bigint
    `,
    txn`
      UPDATE variants
      SET
        is_deleted = true,
        deleted_at = now(),
        delete_source = ${resolvedSource},
        synced_at = now()
      WHERE shop_id = ${resolvedShopId}
        AND product_id = ${resolvedProductId}::bigint
    `,
  ]);
}

/**
 * Soft-deletes stale variants missing from current product payload.
 * @param {string} shopId
 * @param {bigint|string|number} productId
 * @param {Array<bigint|string|number>} liveVariantIds
 * @returns {Promise<number>}
 * @throws {Error}
 */
export async function reconcileVariants(shopId, productId, liveVariantIds) {
  const resolvedShopId = String(shopId || "").trim();
  const resolvedProductId = BigInt(productId).toString();
  if (!resolvedShopId) throw new Error("reconcileVariants requires shopId");

  const live = Array.isArray(liveVariantIds)
    ? liveVariantIds.map((id) => BigInt(id).toString())
    : [];

  if (!live.length) {
    const rows = await sql`
      UPDATE variants
      SET
        is_deleted = true,
        deleted_at = now(),
        delete_source = 'RECONCILE_VARIANT_REMOVAL',
        synced_at = now()
      WHERE shop_id = ${resolvedShopId}
        AND product_id = ${resolvedProductId}::bigint
        AND is_deleted = false
      RETURNING id
    `;
    return rows.length;
  }

  const rows = await sql`
    UPDATE variants
    SET
      is_deleted = true,
      deleted_at = now(),
      delete_source = 'RECONCILE_VARIANT_REMOVAL',
      synced_at = now()
    WHERE shop_id = ${resolvedShopId}
      AND product_id = ${resolvedProductId}::bigint
      AND is_deleted = false
      AND NOT (id = ANY(${live}::bigint[]))
    RETURNING id
  `;
  return rows.length;
}

/**
 * Returns one active product with active variants.
 * @param {string} shopId
 * @param {bigint|string|number} productId
 * @returns {Promise<object|null>}
 * @throws {Error}
 */
export async function getProduct(shopId, productId) {
  const resolvedShopId = String(shopId || "").trim();
  const resolvedProductId = BigInt(productId).toString();
  if (!resolvedShopId) throw new Error("getProduct requires shopId");

  const rows = await sql`
    SELECT
      p.id AS product_id,
      p.title AS product_title,
      p.handle AS product_handle,
      p.status AS product_status,
      p.vendor AS product_vendor,
      p.product_type AS product_type,
      p.tags AS product_tags,
      p.shopify_created_at AS product_created_at,
      p.shopify_updated_at AS product_updated_at,
      v.id AS variant_id,
      v.title AS variant_title,
      v.sku AS variant_sku,
      v.price AS variant_price,
      v.inventory_quantity AS variant_inventory_quantity,
      v.position AS variant_position,
      v.option_values AS variant_option_values,
      v.shopify_created_at AS variant_created_at,
      v.shopify_updated_at AS variant_updated_at
    FROM products p
    LEFT JOIN variants v
      ON v.shop_id = p.shop_id
      AND v.product_id = p.id
      AND v.is_deleted = false
    WHERE p.shop_id = ${resolvedShopId}
      AND p.id = ${resolvedProductId}::bigint
      AND p.is_deleted = false
    ORDER BY v.position ASC, v.id ASC
  `;

  if (!rows.length) return null;
  const head = rows[0];
  return {
    id: head.product_id,
    title: head.product_title,
    handle: head.product_handle,
    status: head.product_status,
    vendor: head.product_vendor,
    productType: head.product_type,
    tags: head.product_tags || [],
    shopifyCreatedAt: head.product_created_at,
    shopifyUpdatedAt: head.product_updated_at,
    variants: rows
      .filter((row) => row.variant_id !== null)
      .map((row) => ({
        id: row.variant_id,
        title: row.variant_title,
        sku: row.variant_sku,
        price: row.variant_price,
        inventoryQuantity: row.variant_inventory_quantity,
        position: row.variant_position,
        optionValues: row.variant_option_values || [],
        shopifyCreatedAt: row.variant_created_at,
        shopifyUpdatedAt: row.variant_updated_at,
      })),
  };
}

/**
 * Lists active products with cursor pagination and optional filters.
 * @param {string} shopId
 * @param {{ limit?: number, cursor?: string|null, search?: string|null, status?: string|null, vendor?: string|null }} params
 * @returns {Promise<{ products: Array<object>, nextCursor: string|null }>}
 * @throws {Error}
 */
export async function listProducts(
  shopId,
  { limit = 50, cursor = null, search = null, status = null, vendor = null } = {},
) {
  const resolvedShopId = String(shopId || "").trim();
  if (!resolvedShopId) throw new Error("listProducts requires shopId");
  const resolvedLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const decoded = decodeCursor(cursor);

  const rows = await sql`
    SELECT
      p.id,
      p.title,
      p.handle,
      p.status,
      p.vendor,
      p.product_type,
      p.tags,
      p.shopify_created_at,
      p.shopify_updated_at,
      p.synced_at
    FROM products p
    WHERE p.shop_id = ${resolvedShopId}
      AND p.is_deleted = false
      AND (${status ? status : null}::text IS NULL OR p.status = ${status ? status : null})
      AND (${vendor ? vendor : null}::text IS NULL OR p.vendor = ${vendor ? vendor : null})
      AND (
        ${search ? `%${search}%` : null}::text IS NULL
        OR p.title ILIKE ${search ? `%${search}%` : null}
        OR p.handle ILIKE ${search ? `%${search}%` : null}
        OR EXISTS (
          SELECT 1
          FROM variants v
          WHERE v.shop_id = p.shop_id
            AND v.product_id = p.id
            AND v.is_deleted = false
            AND v.sku ILIKE ${search ? `%${search}%` : null}
        )
      )
      AND (
        ${decoded?.updatedAt || null}::timestamptz IS NULL
        OR p.shopify_updated_at < ${decoded?.updatedAt || null}::timestamptz
        OR (
          p.shopify_updated_at = ${decoded?.updatedAt || null}::timestamptz
          AND p.id < ${decoded?.id || null}::bigint
        )
      )
    ORDER BY p.shopify_updated_at DESC NULLS LAST, p.id DESC
    LIMIT ${resolvedLimit + 1}
  `;

  const hasMore = rows.length > resolvedLimit;
  const pageRows = hasMore ? rows.slice(0, resolvedLimit) : rows;

  const products = pageRows.map((row) => ({
    id: row.id,
    title: row.title,
    handle: row.handle,
    status: row.status,
    vendor: row.vendor,
    productType: row.product_type,
    tags: row.tags || [],
    shopifyCreatedAt: row.shopify_created_at,
    shopifyUpdatedAt: row.shopify_updated_at,
    syncedAt: row.synced_at,
  }));

  const tail = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && tail
    ? encodeCursor({
        updatedAt: tail.shopify_updated_at,
        id: tail.id,
      })
    : null;

  return { products, nextCursor };
}
