import { Services } from "./productFilterService.js";
import { prisma } from "../../config/database.js";
import { getStoreMirrorState } from "../mirrorHealthService.js";
import { getCache, setCache } from "../../utils/cacheUtils.js";
import { fieldRegistry } from "../targeting/registry/fieldRegistry.js";
import { getTargetingVersionBundle } from "../targeting/versioning.js";

const productService = new Services();
const MAX_LIMIT = 250;

function normalizeProductQueryRequest(query = {}, body = {}) {
  if (
    Object.prototype.hasOwnProperty.call(body, "queryWhere") ||
    Object.prototype.hasOwnProperty.call(query, "queryWhere")
  ) {
    const error = new Error("RAW_QUERY_WHERE_FORBIDDEN");
    error.code = "RAW_QUERY_WHERE_FORBIDDEN";
    throw error;
  }
  if (
    Object.prototype.hasOwnProperty.call(body, "mirrorBatchId") ||
    Object.prototype.hasOwnProperty.call(query, "mirrorBatchId")
  ) {
    const error = new Error("MIRROR_BATCH_OVERRIDE_FORBIDDEN");
    error.code = "MIRROR_BATCH_OVERRIDE_FORBIDDEN";
    throw error;
  }

  const rawLimit = Number.parseInt(String(query.limit || body.limit || "20"), 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT)
    : 20;
  const cursor = query.cursor == null || query.cursor === "" ? null : String(query.cursor);

  const filterParams = body.filterParams;
  if (filterParams != null && !Array.isArray(filterParams)) {
    const error = new Error("INVALID_FILTER_PARAMS");
    error.code = "INVALID_FILTER_PARAMS";
    throw error;
  }

  return {
    queryParams: {
      ...query,
      limit: String(limit),
      cursor,
    },
    filterParams: Array.isArray(filterParams) ? filterParams : [],
  };
}

async function trackFilterQueryIfPossible({ shop, filterParams, count }) {
  if (process.env.NODE_ENV !== "production") return;
  try {
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await prisma.filterTrack.create({
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
  const result = await productService.getProductsWithFilters({
    queryParams: normalized.queryParams,
    filterParams: normalized.filterParams,
    shop,
  });
  const mirrorHealth = await getStoreMirrorState(shop);

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

export async function getPreviewFilterRegistry() {
  const versions = getTargetingVersionBundle();
  const fields = Object.values(fieldRegistry)
    .filter((field) => field?.contexts?.includes("PREVIEW"))
    .map((field) => ({
      key: field.key,
      label: field.key,
      type: mapValueTypeToUiType(field.valueType),
      isSearchable: field.valueType === "string",
      operators: Array.isArray(field.operators)
        ? field.operators.map(mapOperatorToLegacyLabel)
        : [],
    }));

  return {
    versions: {
      fieldRegistryVersion: versions.fieldRegistryVersion,
      operatorRegistryVersion: versions.operatorRegistryVersion,
    },
    fields,
  };
}
