import { prisma } from "../../../config/database.js";
import { FIELD_TRANSLATIONS } from "../../../config/constants.js";
import { FIELD_CONFIGS } from "../../../helpers/productBulkOperationHelpers/constants.js";

const OPTION_NAME_FIELDS = new Set([
  "option1Name",
  "option2Name",
  "option3Name",
  "mixed",
]);

const VARIANT_LEVEL_FIELDS = new Set([
  "price",
  "barcode",
  "sku",
  "inventory",
  "taxable",
  "compareAtPrice",
  "option1Values",
  "option2Values",
  "option3Values",
  "inventoryPolicy",
  "cost",
  "requiresShipping",
  "weight",
  "weightUnit",
]);

export function isVariantLevelField(field) {
  if (FIELD_CONFIGS?.[field]?.isVariantLevel) return true;
  return VARIANT_LEVEL_FIELDS.has(field);
}

export function buildProductInclude(fields = []) {
  if (fields.some((field) => isVariantLevelField(field) || OPTION_NAME_FIELDS.has(field))) {
    return {
      variants: true,
    };
  }
  return undefined;
}

export function normalizeField(field) {
  if (!field) return field;
  const map = {
    compare_at_price: "compareAtPrice",
    compareatprice: "compareAtPrice",
    option1values: "option1Values",
    option2values: "option2Values",
    option3values: "option3Values",
  };
  const key = field.toString().trim();
  return map[key] || key;
}

export function normalizeMirrorProductForPreview(rawProduct) {
  const options = Array.isArray(rawProduct?.options)
    ? rawProduct.options
    : Array.isArray(rawProduct?.optionsJson)
      ? rawProduct.optionsJson
      : [];

  const variants = Array.isArray(rawProduct?.variants)
    ? rawProduct.variants.map((variant) => ({
      ...variant,
      selectedOptions: Array.isArray(variant?.selectedOptions)
        ? variant.selectedOptions
        : Array.isArray(variant?.selectedOptionsJson)
          ? variant.selectedOptionsJson
          : [],
    }))
    : [];

  return {
    ...rawProduct,
    descriptionHtml: rawProduct.descriptionHtml ?? null,
    descriptionText: rawProduct.descriptionText ?? null,
    description: rawProduct.descriptionHtml ?? rawProduct.descriptionText ?? "",
    options,
    variants,
    seo: {
      title: rawProduct?.seo?.title ?? rawProduct?.seoTitle ?? "",
      description: rawProduct?.seo?.description ?? rawProduct?.seoDescription ?? "",
    },
    category: rawProduct?.category ?? (
      rawProduct?.categoryId || rawProduct?.categoryName
        ? { id: rawProduct.categoryId ?? null, name: rawProduct.categoryName ?? "" }
        : null
    ),
    collections: Array.isArray(rawProduct?.collections)
      ? rawProduct.collections
      : Array.isArray(rawProduct?.collectionsJson)
        ? rawProduct.collectionsJson
        : [],
    featuredMedia: rawProduct?.featuredMedia ?? (
      rawProduct?.featuredImageUrl
        ? { preview: { image: { url: rawProduct.featuredImageUrl } } }
        : null
    ),
  };
}

function normalizeMirrorVariantForPreview(variant) {
  return {
    ...variant,
    selectedOptions: Array.isArray(variant?.selectedOptions)
      ? variant.selectedOptions
      : Array.isArray(variant?.selectedOptionsJson)
        ? variant.selectedOptionsJson
        : [],
  };
}

function groupFallbackVariantsByProduct(variants) {
  const grouped = new Map();
  for (const variant of variants) {
    const productId = variant?.productId;
    if (!productId) continue;
    const bucket = grouped.get(productId) || new Map();
    const batchKey = variant?.mirrorBatchId || "__missing_batch__";
    const items = bucket.get(batchKey) || [];
    items.push(normalizeMirrorVariantForPreview(variant));
    bucket.set(batchKey, items);
    grouped.set(productId, bucket);
  }

  const resolved = new Map();
  for (const [productId, batches] of grouped.entries()) {
    const stableBatchKeys = [...batches.keys()].sort();
    const firstBatchVariants = stableBatchKeys.length ? batches.get(stableBatchKeys[0]) : [];
    resolved.set(productId, firstBatchVariants || []);
  }
  return resolved;
}

export async function hydrateMissingVariantsForProducts(products, shop, mirrorBatchId = null) {
  const list = Array.isArray(products) ? products : [];
  const missingProductIds = list
    .filter((product) => Array.isArray(product?.variants) && product.variants.length === 0)
    .map((product) => product.id)
    .filter(Boolean);
  if (!missingProductIds.length) return list;

  const fallbackVariants = await prisma.variant.findMany({
    where: {
      shop,
      productId: { in: missingProductIds },
      ...(mirrorBatchId ? { mirrorBatchId } : {}),
    },
    select: {
      id: true,
      productId: true,
      mirrorBatchId: true,
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
    },
    orderBy: [{ productId: "asc" }, { position: "asc" }],
  });
  if (!fallbackVariants.length) return list;

  const fallbackByProduct = groupFallbackVariantsByProduct(fallbackVariants);
  return list.map((product) => {
    if (!Array.isArray(product?.variants) || product.variants.length > 0) return product;
    const fallback = fallbackByProduct.get(product.id);
    if (!fallback?.length) return product;
    return { ...product, variants: fallback };
  });
}

export { FIELD_TRANSLATIONS };
