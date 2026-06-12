import { db as repositoryDb } from "../../repositories/repositoryDb.js";
import { OPTION_NAME_FIELDS, isVariantLevelField } from "./bulkEditRuleUtils.js";

const db = repositoryDb;

export function buildProductInclude(fields = []) {
  const needsVariants = fields.some(
    (field) => isVariantLevelField(field) || OPTION_NAME_FIELDS.has(field),
  );

  if (!needsVariants) return undefined;

  return {
    variants: true,
  };
}

export function normalizeMirrorProductForPreview(rawProduct) {
  const options = Array.isArray(rawProduct?.options)
    ? rawProduct.options
    : Array.isArray(rawProduct?.optionsJson)
      ? rawProduct.optionsJson
      : [];

  const variants = Array.isArray(rawProduct?.variants)
    ? rawProduct.variants.map((variant) => normalizeMirrorVariantForPreview(variant))
    : [];

  return {
    ...rawProduct,
    descriptionHtml: rawProduct.descriptionHtml ?? null,
    descriptionText: rawProduct.descriptionText ?? null,
    description:
      rawProduct.descriptionHtml ??
      rawProduct.descriptionText ??
      "",
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
    collections: Array.isArray(rawProduct?.collections)
      ? rawProduct.collections
      : Array.isArray(rawProduct?.collectionsJson)
        ? rawProduct.collectionsJson
        : [],
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

export function normalizeMirrorVariantForPreview(variant) {
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

    const bucket = grouped.get(productId) || [];
    bucket.push(normalizeMirrorVariantForPreview(variant));
    grouped.set(productId, bucket);
  }

  return grouped;
}

export async function hydrateMissingVariantsForProducts(
  products,
  shop,
  mirrorBatchId = null,
  db = repositoryDb,
) {
  const list = Array.isArray(products) ? products : [];

  const missingProductIds = list
    .filter((product) => Array.isArray(product?.variants) && product.variants.length === 0)
    .map((product) => product.id)
    .filter(Boolean);

  if (!missingProductIds.length) return list;

  const fallbackVariants = await db.variant.findMany({
    where: {
      shop,
      productId: { in: missingProductIds },
      ...(mirrorBatchId ? { mirrorBatchId } : {}),
    },
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

    const fallback = fallbackByProduct.get(product.id);
    if (!fallback?.length) return product;

    return {
      ...product,
      variants: fallback,
    };
  });
}

