import express from "express";
import { listProducts } from "../../db/products.js";
import { jsonResponse } from "../lib/serialise.js";
import { getDefinitions } from "../db/metafieldDefinitions.js";
import { getVariantsByProductIds } from "../db/productGrid.js";
import { getMetafieldsForVariants } from "../db/variantMetafields.js";

const router = express.Router();

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    return JSON.parse(Buffer.from(String(cursor), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function encodeCursor(cursor) {
  if (!cursor) return null;
  if (typeof cursor === "string") return cursor;
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64");
}

/**
 * GET /api/products
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @returns {Promise<void>}
 */
async function getProductsHandler(req, res) {
  try {
    const shopId = String(res.locals.shop || "").trim();
    if (!shopId) {
      jsonResponse(res, { error: "Unauthenticated session" }, 401);
      return;
    }

    const rawLimit = Number.parseInt(String(req.query.limit || "50"), 10);
    const limit = Math.max(1, Math.min(200, Number.isFinite(rawLimit) ? rawLimit : 50));

    const cursor = req.query.cursor ? String(req.query.cursor) : null;
    if (cursor && !decodeCursor(cursor)) {
      jsonResponse(res, { error: "Invalid cursor", code: "INVALID_CURSOR" }, 400);
      return;
    }

    const search = req.query.search ? String(req.query.search) : null;
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    const vendor = req.query.vendor ? String(req.query.vendor) : null;
    const productType = req.query.productType ? String(req.query.productType) : null;
    const tag = req.query.tag ? String(req.query.tag) : null;

    if (status && !["ACTIVE", "ARCHIVED", "DRAFT"].includes(status)) {
      jsonResponse(res, { error: "Invalid status filter", code: "INVALID_STATUS" }, 400);
      return;
    }

    const listed = await listProducts(shopId, {
      limit,
      cursor,
      search,
      status,
      vendor,
    });

    const filteredProducts = productType
      ? listed.products.filter((p) => String(p.productType || "") === productType)
      : listed.products;
    const tagFilteredProducts = tag
      ? filteredProducts.filter((p) => Array.isArray(p.tags) && p.tags.includes(tag))
      : filteredProducts;

    const productIds = tagFilteredProducts.map((p) => BigInt(p.id));
    const variants = await getVariantsByProductIds(shopId, productIds);
    const variantIds = variants.map((v) => BigInt(v.id));
    const [definitions, metafields] = await Promise.all([
      getDefinitions(shopId),
      getMetafieldsForVariants(shopId, variantIds),
    ]);

    const productById = new Map(
      tagFilteredProducts.map((product) => [String(product.id), product]),
    );
    const definitionKeys = definitions.map((d) => `${d.namespace}.${d.key}`);
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
        compareDigest: mf.compare_digest ?? null,
        shopifyMetafieldId: mf.shopify_metafield_id ?? null,
      });
    }

    const rows = variants
      .filter((variant) => productById.has(String(variant.product_id)))
      .map((variant) => {
        const product = productById.get(String(variant.product_id));
        const existing = metafieldByVariant.get(String(variant.id)) || new Map();
        const metafieldMap = {};

        for (const key of definitionKeys) {
          if (existing.has(key)) {
            metafieldMap[key] = existing.get(key);
          } else {
            const [namespace, defKey] = key.split(".");
            const definition = definitions.find((d) => d.namespace === namespace && d.key === defKey);
            metafieldMap[key] = {
              value: null,
              pendingValue: null,
              editStatus: "SYNCED",
              type: definition?.type || null,
              compareDigest: null,
              shopifyMetafieldId: null,
            };
          }
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

    jsonResponse(res, {
      rows,
      nextCursor: encodeCursor(listed.nextCursor),
      total: rows.length,
    });
  } catch (error) {
    jsonResponse(res, { error: error?.message || "Failed to load products" }, 500);
  }
}

router.get("/", getProductsHandler);

export default router;
