import { Services } from "./productFilterService.js";
import { db } from "../../repositories/repositoryDb.js";
import { getStoreMirrorState } from "../mirrorHealthService.js";
import { recoverStaleProductSyncStateByShop } from "../../repositories/storeRepository.js";
import { getCache, setCache } from "../../utils/cacheUtils.js";
import { fieldRegistry } from "../targeting/registry/fieldRegistry.js";
import { getTargetingVersionBundle } from "../targeting/versioning.js";

const productService = new Services();
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function isRecoverableMirrorQueryError(error) {
  const message = String(error?.message || "");
  const code = String(error?.code || "").toUpperCase();
  return (
    code === "TARGETING_MIRROR_UNSAFE" ||
    code === "NOT_FOUND" ||
    message.includes("Mirror batch unavailable") ||
    message.includes("Mirror is not safe") ||
    message.includes("Product data is still syncing") ||
    message.includes("Store not found")
  );
}

function buildValidationError(message, code = "VALIDATION_FAILED") {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

function normalizeDirection(value) {
  const direction = String(value || "next").trim().toLowerCase();
  if (direction === "next" || direction === "previous") return direction;
  throw buildValidationError("Invalid pagination direction", "INVALID_DIRECTION");
}

function normalizeLimit(query = {}, body = {}) {
  const raw = query.limit ?? body.limit ?? DEFAULT_LIMIT;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(Math.max(parsed, 1), MAX_LIMIT);
}

function normalizeFilters(body = {}) {
  if (body.filterParams != null && !Array.isArray(body.filterParams)) {
    throw buildValidationError("filterParams must be an array", "INVALID_FILTER_PARAMS");
  }
  if (body.filters != null && !Array.isArray(body.filters)) {
    throw buildValidationError("filters must be an array", "INVALID_FILTERS");
  }
  if (body.filter != null && (typeof body.filter !== "object" || Array.isArray(body.filter))) {
    throw buildValidationError("filter must be an object or null", "INVALID_FILTER");
  }

  const filters = Array.isArray(body.filterParams)
    ? body.filterParams
    : Array.isArray(body.filters)
      ? body.filters
      : [];

  return filters.map((filter, index) => {
    if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
      throw buildValidationError(`Invalid filter at index ${index}`, "INVALID_FILTER");
    }

    return {
      field: String(filter.field ?? "").trim(),
      operator: String(filter.operator ?? "").trim(),
      value: filter.value ?? null,
    };
  }).filter((filter) => filter.field);
}

function normalizeProductQueryRequest(query = {}, body = {}) {
  const safeQuery = query && typeof query === "object" ? query : {};
  const safeBody = body && typeof body === "object" ? body : {};

  if (
    Object.prototype.hasOwnProperty.call(safeBody, "queryWhere") ||
    Object.prototype.hasOwnProperty.call(safeQuery, "queryWhere")
  ) {
    throw buildValidationError("RAW_QUERY_WHERE_FORBIDDEN", "RAW_QUERY_WHERE_FORBIDDEN");
  }
  if (
    Object.prototype.hasOwnProperty.call(safeBody, "mirrorBatchId") ||
    Object.prototype.hasOwnProperty.call(safeQuery, "mirrorBatchId")
  ) {
    throw buildValidationError("MIRROR_BATCH_OVERRIDE_FORBIDDEN", "MIRROR_BATCH_OVERRIDE_FORBIDDEN");
  }

  const limit = normalizeLimit(safeQuery, safeBody);
  const cursorValue = safeQuery.cursor ?? safeBody.cursor;
  const cursor = cursorValue == null || cursorValue === "" ? null : String(cursorValue);
  const direction = normalizeDirection(safeQuery.direction ?? safeBody.direction);
  const filterParams = normalizeFilters(safeBody);

  return {
    queryParams: {
      ...safeQuery,
      limit: String(limit),
      cursor,
      direction,
    },
    filterParams,
  };
}

async function trackFilterQueryIfPossible({ shop, filterParams, count }) {
  if (process.env.NODE_ENV !== "production") return;
  try {
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db.filterTrack.create({
      data: {
        shop,
        filterParams,
        respondProductCount: count || 0,
        type: "filter",
        source: "product_query",
        expiresAt,
      },
    });
  } catch {
    // Best-effort telemetry write. Query response must not fail on tracking errors.
  }
}

export async function executeProductQuery({ shop, query = {}, body = {} }) {
  const normalized = normalizeProductQueryRequest(query, body);
  await recoverStaleProductSyncStateByShop(shop);
  const mirrorHealth = await getStoreMirrorState(shop);

  let result;
  try {
    result = await productService.getProductsWithFilters({
      queryParams: normalized.queryParams,
      filterParams: normalized.filterParams,
      shop,
    });
  } catch (error) {
    if (!isRecoverableMirrorQueryError(error)) {
      throw error;
    }

    result = {
      products: [],
      count: 0,
      pagination: {
        page: 1,
        totalPages: 0,
        total: 0,
        hasNextPage: false,
        hasPrevPage: false,
        nextCursor: null,
        prevCursor: null,
        endCursor: null,
      },
      mirrorBatchId: mirrorHealth?.activeMirrorBatchId || null,
      unavailableReason: error?.message || "Product mirror is not ready.",
    };
  }

  await trackFilterQueryIfPossible({
    shop,
    filterParams: normalized.filterParams,
    count: result?.count || 0,
  });

  return {
    ...result,
    mirrorHealth,
  };
}

export async function getProductTypeOptions({ shop, search = "", limit = 20 }) {
  const cacheKey = `${shop}:productTypes:${String(search).toLowerCase()}:${limit}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  const data = await productService.getDistinctProductFilterValues({
    shop,
    field: "product_type",
    search,
    take: limit,
  });
  await setCache(cacheKey, data, 300);
  return data;
}

export async function getProductFilterValueOptions({
  shop,
  field,
  search = "",
  limit = 20,
}) {
  return productService.getDistinctProductFilterValues({
    shop,
    field,
    search,
    take: limit,
  });
}

function mapValueTypeToUiType(valueType) {
  if (valueType === "number") return "number";
  if (valueType === "date") return "date";
  if (valueType === "boolean") return "enum";
  return "string";
}

function mapOperatorToLegacyLabel(operator) {
  const map = {
    EQ: "equals",
    NEQ: "does not equal",
    CONTAINS: "contains",
    NOT_CONTAINS: "does not contain",
    STARTS_WITH: "starts with",
    ENDS_WITH: "ends with",
    LT: "<",
    LTE: "<=",
    GT: ">",
    GTE: ">=",
    IN: "is",
    NOT_IN: "is not",
    IS_EMPTY: "is empty/blank",
    IS_NOT_EMPTY: "is not empty",
    BETWEEN: "between",
  };
  return map[operator] || String(operator || "").toLowerCase();
}

const FILTER_UI_OVERRIDES = Object.freeze({
  title: {
    label: "Product title",
    searchAliases: ["product", "name"],
  },
  vendor: {
    label: "Vendor",
    api: "/api/products/filter-values/vendor",
    isSearchable: true,
    allowFreeText: true,
    minQueryLength: 1,
    searchAliases: ["brand", "supplier"],
  },
  status: {
    label: "Status",
    type: "enum",
    isSearchable: false,
    operators: ["equals", "does not equal"],
    values: ["ACTIVE", "DRAFT", "ARCHIVED"],
    searchAliases: ["active", "draft", "archived"],
  },
  productType: {
    label: "Product type",
    api: "/api/products/filter-values/product_type",
    isSearchable: true,
    allowFreeText: true,
    minQueryLength: 1,
    searchAliases: ["product", "type"],
  },
  handle: {
    label: "Handle",
    searchAliases: ["url"],
  },
  tags: {
    label: "Tags",
    api: "/api/products/filter-values/tag",
    isSearchable: true,
    allowFreeText: true,
    minQueryLength: 1,
    searchAliases: ["tag"],
  },
  sku: {
    label: "SKU",
    searchAliases: ["variant sku"],
  },
  barcode: {
    label: "Barcode",
    searchAliases: ["variant barcode"],
  },
  price: {
    label: "Price",
    inputMode: "decimal",
  },
  inventoryQuantity: {
    label: "Inventory",
    inputMode: "numeric",
    searchAliases: ["stock", "quantity"],
  },
  collections: {
    label: "Collection",
    api: "/api/products/filter-values/collection",
    isSearchable: true,
    allowFreeText: false,
    minQueryLength: 1,
    searchAliases: ["collection"],
  },
  categoryName: {
    label: "Category",
    api: "/api/products/filter-values/category",
    isSearchable: true,
    allowFreeText: true,
    minQueryLength: 1,
  },
  productMetafield: {
    label: "Product metafield",
    searchAliases: ["metafield"],
  },
  variantMetafield: {
    label: "Variant metafield",
    searchAliases: ["metafield"],
  },
});

function buildFilterFieldDto(field) {
  const override = FILTER_UI_OVERRIDES[field.key] || {};
  const type = override.type || mapValueTypeToUiType(field.valueType);
  const operators = Array.isArray(override.operators)
    ? override.operators
    : Array.isArray(field.operators)
      ? field.operators.map(mapOperatorToLegacyLabel)
      : [];

  return {
    key: field.key,
    label: override.label || field.key,
    type,
    isSearchable:
      override.isSearchable ??
      (field.valueType === "string" && type !== "enum"),
    operators,
    ...(override.api ? { api: override.api } : {}),
    ...(Array.isArray(override.values) ? { values: override.values } : {}),
    ...(override.allowFreeText !== undefined ? { allowFreeText: override.allowFreeText } : {}),
    ...(override.minQueryLength !== undefined ? { minQueryLength: override.minQueryLength } : {}),
    ...(override.inputMode ? { inputMode: override.inputMode } : {}),
    ...(Array.isArray(override.searchAliases) ? { searchAliases: override.searchAliases } : {}),
  };
}

export async function getPreviewFilterRegistry() {
  const versions = getTargetingVersionBundle();
  const fields = Object.values(fieldRegistry)
    .filter((field) => field?.contexts?.includes("PREVIEW"))
    .map(buildFilterFieldDto);

  return {
    versions: {
      fieldRegistryVersion: versions.fieldRegistryVersion,
      operatorRegistryVersion: versions.operatorRegistryVersion,
    },
    fields,
  };
}

