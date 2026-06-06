import { getCache, setCache } from "../../utils/cacheUtils.js";
import crypto from "crypto";
import {
  findDistinctCollectionTitles,
  findDistinctProductFieldValues,
  findDistinctProductTagValues,
  findDistinctVariantFieldValues,
} from "../../repositories/productQueryRepository.js";
import {
  getActiveMirrorBatchId,
} from "./productTargetingService.js";
import { TargetingEngineService } from "../targeting/TargetingEngineService.js";
import { TARGET_TYPES } from "../targeting/constants.js";

const FILTER_VALUE_FIELD_MAP = {
  title: { source: "product", field: "title" },
  vendor: { source: "product", field: "vendor" },
  handle: { source: "product", field: "handle" },
  status: { source: "product", field: "status" },
  tag: { source: "product_tags", field: "value" },
  tags: { source: "product_tags", field: "value" },
  product_type: { source: "product", field: "productType" },
  productType: { source: "product", field: "productType" },
  category: { source: "product", field: "categoryName" },
  categoryName: { source: "product", field: "categoryName" },
  collections: { source: "collection", field: "title" },
  option_name_1: { source: "product", field: "option1Name" },
  option_name_2: { source: "product", field: "option2Name" },
  option_name_3: { source: "product", field: "option3Name" },
  collection: { source: "collection", field: "title" },
  googleShoppingCategory: { source: "product", field: "googleShoppingCategory" },
  googleShoppingColor: { source: "product", field: "googleShoppingColor" },
  googleShoppingCustomLabel0: { source: "product", field: "googleShoppingCustomLabel0" },
  googleShoppingCustomLabel1: { source: "product", field: "googleShoppingCustomLabel1" },
  googleShoppingCustomLabel2: { source: "product", field: "googleShoppingCustomLabel2" },
  googleShoppingCustomLabel3: { source: "product", field: "googleShoppingCustomLabel3" },
  googleShoppingCustomLabel4: { source: "product", field: "googleShoppingCustomLabel4" },
  googleShoppingMpn: { source: "product", field: "googleShoppingMpn" },
  googleShoppingMaterial: { source: "product", field: "googleShoppingMaterial" },
  googleShoppingSize: { source: "product", field: "googleShoppingSize" },
  categoryAgeGroup: { source: "product", field: "categoryAgeGroup", splitValues: true },
  categoryColor: { source: "product", field: "categoryColor", splitValues: true },
  categoryFabric: { source: "product", field: "categoryFabric", splitValues: true },
  categoryFit: { source: "product", field: "categoryFit", splitValues: true },
  categorySize: { source: "product", field: "categorySize", splitValues: true },
  categoryTargetGender: { source: "product", field: "categoryTargetGender", splitValues: true },
  categoryWaistRise: { source: "product", field: "categoryWaistRise", splitValues: true },
  option_value_1: { source: "variant", field: "option1Value" },
  option_value_2: { source: "variant", field: "option2Value" },
  option_value_3: { source: "variant", field: "option3Value" },
  country_of_origin: { source: "variant", field: "countryOfOrigin" },
  inventory_policy: { source: "variant", field: "inventoryPolicy" },
  weight_unit: { source: "variant", field: "weightUnit" },
};

const PRODUCT_LIST_CACHE_TTL_SECONDS = Number.parseInt(
  process.env.PRODUCT_LIST_CACHE_TTL_SECONDS || "60",
  10,
);

function sortObjectKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sortObjectKeysDeep(item));
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort((a, b) => a.localeCompare(b))
      .reduce((acc, key) => {
        acc[key] = sortObjectKeysDeep(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(sortObjectKeysDeep(value));
}

function buildProductListCacheKey({
  shop,
  mirrorBatchId,
  filterAst,
  filterParams,
  queryParams,
}) {
  const normalizedFilterHash = crypto
    .createHash("sha256")
    .update(stableJson(filterAst || filterParams || []))
    .digest("hex");

  const normalizedQuery = {
    sortKey: String(queryParams?.sortKey || "ID").toUpperCase(),
    sortOrder: String(queryParams?.sortOrder || "asc").toLowerCase(),
    limit: Number.parseInt(String(queryParams?.limit || "20"), 10) || 20,
    cursor: queryParams?.cursor == null ? null : String(queryParams.cursor),
  };

  const queryHash = crypto
    .createHash("sha256")
    .update(stableJson(normalizedQuery))
    .digest("hex");

  return [
    shop,
    "product_list_v2",
    String(mirrorBatchId || "none"),
    normalizedFilterHash,
    queryHash,
  ].join(":");
}

function normalizeDistinctOptions(values = [], { splitValues = false } = {}) {
  const normalizedValues = values.flatMap((value) => {
    if (typeof value !== "string") {
      return [];
    }

    if (!splitValues) {
      const normalized = value.trim();
      return normalized ? [normalized] : [];
    }

    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  });

  return Array.from(new Set(normalizedValues))
    .sort((a, b) => a.localeCompare(b))
    .map((value) => ({
      label: value,
      value,
      title: value,
    }));
}

export async function getProductsWithFilters({
  queryParams = {},
  filterAst = null,
  filterParams = [],
  shop = null,
}) {
  const { cursor = null, limit = 20, sortKey, sortOrder } = queryParams;
  const mirrorBatchId = await getActiveMirrorBatchId(shop, { purpose: "PREVIEW" });
  const cacheKey = buildProductListCacheKey({
    shop,
    mirrorBatchId,
    filterAst,
    filterParams,
    queryParams: { cursor, limit, sortKey, sortOrder },
  });
  const cachedData = await getCache(cacheKey);

  if (cachedData) return cachedData;

  const result = await TargetingEngineService.resolvePreviewTargets({
    shop,
    targetType: TARGET_TYPES.PRODUCT,
    targetGranularity: "PRODUCT",
    filterAst,
    legacyFilterParams: null,
    queryParams: { cursor, limit, sortKey, sortOrder },
    sampleLimit: Number.parseInt(limit, 10) || 20,
    source: "PRODUCT_LISTING",
  });

  const returnData = {
    products: result.sampleProducts,
    count: result.count,
    pagination: result.pagination,
    mirrorBatchId: result.mirrorBatchId,
  };

  await setCache(cacheKey, returnData, PRODUCT_LIST_CACHE_TTL_SECONDS);

  return returnData;
}

export async function getDistinctProductFilterValues({
  shop,
  field,
  search = "",
  take = 20,
}) {
  const fieldConfig = FILTER_VALUE_FIELD_MAP[field];
  if (!fieldConfig) {
    const error = new Error(`Unsupported filter field: ${field}`);
    error.code = "INVALID_FILTER_FIELD";
    throw error;
  }

  const cacheKey = `${shop}:ProductFilterValues:${field}:${search.toLowerCase()}:${take}`;
  const cachedData = await getCache(cacheKey);
  if (cachedData) return cachedData;

  const mirrorBatchId = await getActiveMirrorBatchId(shop, { purpose: "PREVIEW" });
  let rows = [];

  if (fieldConfig.source === "product") {
    rows = await findDistinctProductFieldValues({
      shop,
      field: fieldConfig.field,
      mirrorBatchId,
      search,
      take,
    });
  } else if (fieldConfig.source === "variant") {
    rows = await findDistinctVariantFieldValues({
      shop,
      field: fieldConfig.field,
      mirrorBatchId,
      search,
      take,
    });
  } else if (fieldConfig.source === "collection") {
    rows = await findDistinctCollectionTitles({
      shop,
      search,
      take,
    });
  } else if (fieldConfig.source === "product_tags") {
    rows = await findDistinctProductTagValues({
      shop,
      mirrorBatchId,
      search,
      take,
    });
  }

  const result = normalizeDistinctOptions(
    rows.map((row) => row?.[fieldConfig.field]),
    { splitValues: fieldConfig.splitValues === true },
  );

  await setCache(cacheKey, result, 300);

  return result;
}
