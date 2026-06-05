import { db as defaultDb } from "../../repositories/repositoryDb.js";
import { OPTION_NAME_FIELDS, isVariantLevelField } from "./bulkEditRuleUtils.js";

export const PREVIEW_VARIANT_SELECT = Object.freeze({
  id: true,
  productId: true,
  position: true,
  title: true,
  price: true,
  compareAtPrice: true,
  barcode: true,
  sku: true,
  taxable: true,
  inventoryPolicy: true,
  inventoryQuantity: true,
  cost: true,
  requiresShipping: true,
  weight: true,
  weightUnit: true,
  selectedOptionsJson: true,
  selectedOptions: true,
});

export const PREVIEW_PRODUCT_SELECT = Object.freeze({
  id: true,
  title: true,
  descriptionHtml: true,
  descriptionText: true,
  handle: true,
  vendor: true,
  productType: true,
  status: true,
  tags: true,
  optionsJson: true,
  options: true,
  seo: true,
  seoTitle: true,
  seoDescription: true,
  category: true,
  categoryId: true,
  categoryName: true,
  collectionsJson: true,
  collections: true,
  featuredMedia: true,
  featuredImageUrl: true,
});

function stableStringify(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error(`${label}_REQUIRES_OBJECT`);
    error.code = `${label}_REQUIRES_OBJECT`;
    throw error;
  }
}

function chooseArraySource({ label, relationValue, jsonValue }) {
  const hasRelation = Array.isArray(relationValue);
  const hasJson = Array.isArray(jsonValue);
  if (hasRelation && hasJson && stableStringify(relationValue) !== stableStringify(jsonValue)) {
    const error = new Error(`PREVIEW_${label}_SOURCE_MISMATCH`);
    error.code = `PREVIEW_${label}_SOURCE_MISMATCH`;
    throw error;
  }
  if (hasRelation) return relationValue;
  if (hasJson) return jsonValue;
  return [];
}

export function buildProductInclude(fields = []) {
  const needsVariants = fields.some(
    (field) => isVariantLevelField(field) || OPTION_NAME_FIELDS.has(field),
  );

  if (!needsVariants) return undefined;

  return {
    variants: {
      select: PREVIEW_VARIANT_SELECT,
    },
  };
}

export function normalizeMirrorVariantForPreview(variant) {
  assertPlainObject(variant, "PREVIEW_VARIANT");
  return {
    id: variant.id == null ? null : String(variant.id),
    productId: variant.productId == null ? null : String(variant.productId),
    position: variant.position ?? null,
    title: variant.title ?? "",
    price: variant.price ?? null,
    compareAtPrice: variant.compareAtPrice ?? null,
    barcode: variant.barcode ?? null,
    sku: variant.sku ?? null,
    taxable: variant.taxable ?? null,
    inventoryPolicy: variant.inventoryPolicy ?? null,
    inventoryQuantity: variant.inventoryQuantity ?? null,
    cost: variant.cost ?? null,
    requiresShipping: variant.requiresShipping ?? null,
    weight: variant.weight ?? null,
    weightUnit: variant.weightUnit ?? null,
    selectedOptions: chooseArraySource({
      label: "VARIANT_SELECTED_OPTIONS",
      relationValue: variant.selectedOptions,
      jsonValue: variant.selectedOptionsJson,
    }),
  };
}

export function normalizeMirrorProductForPreview(rawProduct) {
  assertPlainObject(rawProduct, "PREVIEW_PRODUCT");

  const options = chooseArraySource({
    label: "PRODUCT_OPTIONS",
    relationValue: rawProduct.options,
    jsonValue: rawProduct.optionsJson,
  });

  const variants = Array.isArray(rawProduct.variants)
    ? rawProduct.variants.map((variant) => normalizeMirrorVariantForPreview(variant))
    : [];

  const collections = chooseArraySource({
    label: "PRODUCT_COLLECTIONS",
    relationValue: rawProduct.collections,
    jsonValue: rawProduct.collectionsJson,
  });

  return {
    id: rawProduct.id == null ? null : String(rawProduct.id),
    title: rawProduct.title ?? "",
    descriptionHtml: rawProduct.descriptionHtml ?? null,
    descriptionText: rawProduct.descriptionText ?? null,
    handle: rawProduct.handle ?? "",
    vendor: rawProduct.vendor ?? "",
    productType: rawProduct.productType ?? "",
    status: rawProduct.status ?? null,
    tags: Array.isArray(rawProduct.tags) ? rawProduct.tags : [],
    options,
    variants,
    seo: {
      title: rawProduct?.seo?.title ?? rawProduct?.seoTitle ?? "",
      description: rawProduct?.seo?.description ?? rawProduct?.seoDescription ?? "",
    },
    category: rawProduct?.category ?? (
      rawProduct?.categoryId || rawProduct?.categoryName
        ? {
            id: rawProduct.categoryId ?? null,
            name: rawProduct.categoryName ?? "",
          }
        : null
    ),
    collections,
    featuredMedia: rawProduct?.featuredMedia ?? (
      rawProduct?.featuredImageUrl
        ? {
            preview: {
              image: {
                url: rawProduct.featuredImageUrl,
              },
            },
          }
        : null
    ),
  };
}

function groupFallbackVariantsByProduct(variants) {
  const grouped = new Map();

  for (const variant of variants) {
    const productId = variant?.productId == null ? "" : String(variant.productId).trim();
    if (!productId) continue;

    const bucket = grouped.get(productId) || [];
    bucket.push(normalizeMirrorVariantForPreview(variant));
    grouped.set(productId, bucket);
  }

  return grouped;
}

export async function hydrateMissingVariantsForProducts(
  products,
  shop,
  mirrorBatchId,
  db = defaultDb,
) {
  const resolvedShop = String(shop || "").trim();
  const resolvedMirrorBatchId = String(mirrorBatchId || "").trim();
  if (!resolvedShop || !resolvedMirrorBatchId) {
    const error = new Error("PREVIEW_VARIANT_HYDRATION_REQUIRES_SHOP_AND_MIRROR_BATCH");
    error.code = "PREVIEW_VARIANT_HYDRATION_REQUIRES_SHOP_AND_MIRROR_BATCH";
    throw error;
  }

  const list = Array.isArray(products) ? products : [];

  const missingProductIds = [...new Set(list
    .filter((product) => Array.isArray(product?.variants) && product.variants.length === 0)
    .map((product) => (product?.id == null ? "" : String(product.id).trim()))
    .filter(Boolean))];

  if (!missingProductIds.length) return list;

  const fallbackVariants = await db.variant.findMany({
    where: {
      shop: resolvedShop,
      mirrorBatchId: resolvedMirrorBatchId,
      productId: { in: missingProductIds },
    },
    select: PREVIEW_VARIANT_SELECT,
    orderBy: [
      { productId: "asc" },
      { position: "asc" },
    ],
  });

  if (!fallbackVariants.length) return list;

  const fallbackByProduct = groupFallbackVariantsByProduct(fallbackVariants);

  return list.map((product) => {
    if (!Array.isArray(product?.variants) || product.variants.length > 0) {
      return product;
    }

    const productId = product?.id == null ? "" : String(product.id).trim();
    const fallback = fallbackByProduct.get(productId);
    if (!fallback?.length) return product;

    return {
      ...product,
      variants: fallback,
    };
  });
}
