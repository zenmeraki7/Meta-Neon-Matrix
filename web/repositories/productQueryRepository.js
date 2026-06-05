import { createRequire } from "node:module";
import { prisma } from "../config/database.js";

const require = createRequire(import.meta.url);
const prismaGenerated = require("../generated/prisma/index.js");
const { Prisma } = prismaGenerated;

const DEFAULT_DISTINCT_TAKE = 20;
const MAX_DISTINCT_TAKE = 200;
const NON_NULL_PRODUCT_FILTER_FIELDS = new Set(["title", "status"]);
const ALLOWED_PRODUCT_DISTINCT_FIELDS = new Set([
  "title",
  "vendor",
  "handle",
  "status",
  "productType",
  "categoryName",
  "option1Name",
  "option2Name",
  "option3Name",
  "googleShoppingCategory",
  "googleShoppingColor",
  "googleShoppingCustomLabel0",
  "googleShoppingCustomLabel1",
  "googleShoppingCustomLabel2",
  "googleShoppingCustomLabel3",
  "googleShoppingCustomLabel4",
  "googleShoppingMpn",
  "googleShoppingMaterial",
  "googleShoppingSize",
  "categoryAgeGroup",
  "categoryColor",
  "categoryFabric",
  "categoryFit",
  "categorySize",
  "categoryTargetGender",
  "categoryWaistRise",
]);
const ALLOWED_VARIANT_DISTINCT_FIELDS = new Set([
  "option1Value",
  "option2Value",
  "option3Value",
  "countryOfOrigin",
  "inventoryPolicy",
  "weightUnit",
]);

function requireShop(shop, caller) {
  const scopedShop = String(shop || "").trim();
  if (!scopedShop) {
    throw new Error(`${caller} requires shop`);
  }
  return scopedShop;
}

function safeTake(take, fallback = DEFAULT_DISTINCT_TAKE) {
  const parsed = Number.parseInt(String(take ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_DISTINCT_TAKE);
}

function requireAllowedField(field, allowedFields, caller) {
  const safeField = String(field || "").trim();
  if (!allowedFields.has(safeField)) {
    throw new Error(`${caller} invalid field: ${safeField || "missing"}`);
  }
  return safeField;
}

async function resolveActiveProductBatchId(shop, mirrorBatchId = null) {
  if (mirrorBatchId) return String(mirrorBatchId);
  const row = await prisma.store.findUnique({
    where: { shopUrl: shop },
    select: { activeMirrorBatchId: true },
  });
  if (!row?.activeMirrorBatchId) {
    throw new Error("ACTIVE_PRODUCT_MIRROR_BATCH_NOT_FOUND");
  }
  return row.activeMirrorBatchId;
}

async function resolveActiveCollectionBatchId(shop, mirrorBatchId = null) {
  if (mirrorBatchId) return String(mirrorBatchId);
  const row = await prisma.store.findUnique({
    where: { shopUrl: shop },
    select: { activeCollectionBatchId: true },
  });
  if (!row?.activeCollectionBatchId) {
    throw new Error("ACTIVE_COLLECTION_MIRROR_BATCH_NOT_FOUND");
  }
  return row.activeCollectionBatchId;
}

function buildDistinctStringFieldWhere({
  shop,
  field,
  mirrorBatchId,
  search = "",
  isNullable = true,
}) {
  const trimmedSearch = String(search || "").trim();
  return {
    shop,
    mirrorBatchId,
    AND: [
      ...(isNullable ? [{ NOT: { [field]: null } }] : []),
      { NOT: { [field]: "" } },
      ...(trimmedSearch
        ? [{
            [field]: {
              contains: trimmedSearch,
              mode: "insensitive",
            },
          }]
        : []),
    ],
  };
}

export async function findProductsForListing({
  shop,
  mirrorBatchId = null,
  where = {},
  orderBy,
  skip,
  take,
}) {
  const scopedShop = requireShop(shop, "findProductsForListing");
  const scopedMirrorBatchId = await resolveActiveProductBatchId(scopedShop, mirrorBatchId);
  return prisma.product.findMany({
    where: {
      ...(where || {}),
      shop: scopedShop,
      mirrorBatchId: scopedMirrorBatchId,
    },
    select: {
      title: true,
      id: true,
      status: true,
      productType: true,
      vendor: true,
      totalInventory: true,
      featuredImageUrl: true,
      categoryName: true,
      handle: true,
      templateSuffix: true,
      variantCount: true,
      visibleOnlineStore: true,
    },
    orderBy,
    skip,
    take,
  });
}

export async function countProducts({ shop, mirrorBatchId = null, where = {} }) {
  const scopedShop = requireShop(shop, "countProducts");
  const scopedMirrorBatchId = await resolveActiveProductBatchId(scopedShop, mirrorBatchId);
  return prisma.product.count({
    where: {
      ...(where || {}),
      shop: scopedShop,
      mirrorBatchId: scopedMirrorBatchId,
    },
  });
}

export async function findDistinctProductFieldValues({
  shop,
  field,
  mirrorBatchId = null,
  search = "",
  take = DEFAULT_DISTINCT_TAKE,
}) {
  const scopedShop = requireShop(shop, "findDistinctProductFieldValues");
  const safeField = requireAllowedField(
    field,
    ALLOWED_PRODUCT_DISTINCT_FIELDS,
    "findDistinctProductFieldValues",
  );
  const scopedMirrorBatchId = await resolveActiveProductBatchId(scopedShop, mirrorBatchId);
  return prisma.product.findMany({
    where: buildDistinctStringFieldWhere({
      shop: scopedShop,
      field: safeField,
      mirrorBatchId: scopedMirrorBatchId,
      search,
      isNullable: !NON_NULL_PRODUCT_FILTER_FIELDS.has(safeField),
    }),
    select: {
      [safeField]: true,
    },
    distinct: [safeField],
    orderBy: {
      [safeField]: "asc",
    },
    take: safeTake(take),
  });
}

export async function findDistinctVariantFieldValues({
  shop,
  field,
  mirrorBatchId = null,
  search = "",
  take = DEFAULT_DISTINCT_TAKE,
}) {
  const scopedShop = requireShop(shop, "findDistinctVariantFieldValues");
  const safeField = requireAllowedField(
    field,
    ALLOWED_VARIANT_DISTINCT_FIELDS,
    "findDistinctVariantFieldValues",
  );
  const scopedMirrorBatchId = await resolveActiveProductBatchId(scopedShop, mirrorBatchId);
  return prisma.variant.findMany({
    where: buildDistinctStringFieldWhere({
      shop: scopedShop,
      field: safeField,
      mirrorBatchId: scopedMirrorBatchId,
      search,
      isNullable: true,
    }),
    select: {
      [safeField]: true,
    },
    distinct: [safeField],
    orderBy: {
      [safeField]: "asc",
    },
    take: safeTake(take),
  });
}

export async function findDistinctCollectionTitles({
  shop,
  mirrorBatchId = null,
  search = "",
  take = DEFAULT_DISTINCT_TAKE,
}) {
  const scopedShop = requireShop(shop, "findDistinctCollectionTitles");
  const scopedMirrorBatchId = await resolveActiveCollectionBatchId(scopedShop, mirrorBatchId);
  return prisma.collection.findMany({
    where: buildDistinctStringFieldWhere({
      shop: scopedShop,
      field: "title",
      mirrorBatchId: scopedMirrorBatchId,
      search,
      isNullable: true,
    }),
    select: {
      title: true,
    },
    distinct: ["title"],
    orderBy: {
      title: "asc",
    },
    take: safeTake(take),
  });
}

export async function findDistinctProductTagValues({
  shop,
  mirrorBatchId = null,
  search = "",
  take = DEFAULT_DISTINCT_TAKE,
}) {
  const scopedShop = requireShop(shop, "findDistinctProductTagValues");
  const scopedMirrorBatchId = await resolveActiveProductBatchId(scopedShop, mirrorBatchId);
  const trimmedSearch = String(search || "").trim();
  const searchClause =
    trimmedSearch.length > 0
      ? Prisma.sql`AND tag ILIKE ${`%${trimmedSearch}%`}`
      : Prisma.empty;

  return prisma.$queryRaw`
    SELECT DISTINCT tag AS value
    FROM "Product"
    CROSS JOIN LATERAL UNNEST("tags") AS tag
    WHERE "shop" = ${scopedShop}
      AND "mirrorBatchId" = ${scopedMirrorBatchId}
      AND tag IS NOT NULL
      AND BTRIM(tag) <> ''
      ${searchClause}
    ORDER BY tag ASC
    LIMIT ${safeTake(take)}
  `;
}
