import { FILTER_AST_VERSION } from "../versioning.js";
import { TargetingValidationError } from "../errors/TargetingValidationError.js";
import { TARGET_GRANULARITIES } from "../types.js";
import { fieldRegistry } from "../registry/fieldRegistry.js";
import { operatorRegistry } from "../registry/operatorRegistry.js";

const LEGACY_SEARCH_FIELDS = Object.freeze([
  "title",
  "vendor",
  "productType",
  "handle",
  "categoryName",
]);

function mapLegacyFieldAlias(field) {
  const raw = String(field || "").trim();
  const aliasMap = {
    product_type: "productType",
    productType: "productType",
    vendor_name: "vendor",
    stock: "inventoryQuantity",
    inventory: "inventoryQuantity",
  };

  if (raw === "search") return raw;

  const mapped = aliasMap[raw] || raw;
  if (!fieldRegistry[mapped]) {
    throw new TargetingValidationError("LEGACY_FILTER_INVALID_FIELD", {
      code: "LEGACY_FILTER_INVALID_FIELD",
      meta: { field: raw },
    });
  }
  return mapped;
}

function mapLegacyOperatorAlias(op) {
  const upper = String(op || "").trim().toUpperCase();
  const map = {
    EQUALS: "EQ",
    EQ: "EQ",
    NOT_EQUALS: "NEQ",
    "DOES NOT EQUAL": "NEQ",
    NEQ: "NEQ",
    IS: "IN",
    IS_NOT: "NOT_IN",
    "IS NOT": "NOT_IN",
    CONTAINS: "CONTAINS",
    NOT_CONTAINS: "NOT_CONTAINS",
    "DOES NOT CONTAIN": "NOT_CONTAINS",
    STARTS_WITH: "STARTS_WITH",
    "STARTS WITH": "STARTS_WITH",
    ENDS_WITH: "ENDS_WITH",
    "ENDS WITH": "ENDS_WITH",
    IN: "IN",
    NOT_IN: "NOT_IN",
    "<": "LT",
    LT: "LT",
    LESS_THAN: "LT",
    ">": "GT",
    "=": "EQ",
    "!=": "NEQ",
    "<=": "LTE",
    ">=": "GTE",
    LTE: "LTE",
    LESS_THAN_OR_EQUAL: "LTE",
    GT: "GT",
    GREATER_THAN: "GT",
    GTE: "GTE",
    GREATER_THAN_OR_EQUAL: "GTE",
    BETWEEN: "BETWEEN",
    IS_EMPTY: "IS_EMPTY",
    "IS EMPTY": "IS_EMPTY",
    "IS EMPTY/BLANK": "IS_EMPTY",
    IS_NOT_EMPTY: "IS_NOT_EMPTY",
    "IS NOT EMPTY": "IS_NOT_EMPTY",
    EXISTS: "EXISTS",
    NOT_EXISTS: "NOT_EXISTS",
  };
  const mapped = map[upper] || upper;
  if (!operatorRegistry[mapped]) {
    throw new TargetingValidationError("LEGACY_FILTER_INVALID_OPERATOR", {
      code: "LEGACY_FILTER_INVALID_OPERATOR",
      meta: { operator: op },
    });
  }
  return mapped;
}

function normalizeLegacyRawValue(value, operator) {
  if (typeof value !== "string") {
    if (operator === "IN" || operator === "NOT_IN") {
      if (value === null || value === undefined) return [];
      return Array.isArray(value) ? value : [value];
    }
    return value;
  }
  const trimmed = value.trim();
  let normalized = trimmed;

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) normalized = Number(trimmed);
  else if (trimmed.toLowerCase() === "true") normalized = true;
  else if (trimmed.toLowerCase() === "false") normalized = false;
  else if (trimmed === "") normalized = null;

  if (operator === "IN" || operator === "NOT_IN") {
    if (normalized === null || normalized === undefined) return [];
    return Array.isArray(normalized) ? normalized : [normalized];
  }

  return normalized;
}

function extractLegacyMeta(filter) {
  const { field, operator, value, ...rest } = filter || {};
  return rest;
}

function buildLegacySearchGroup(filter, index) {
  const value = String(filter?.value || "").trim();
  return {
    nodeType: "group",
    logic: "OR",
    children: LEGACY_SEARCH_FIELDS.map((field) => ({
      nodeType: "predicate",
      field,
      operator: "CONTAINS",
      value,
      meta: {
        ...extractLegacyMeta(filter),
        legacyIndex: index,
        legacySearchField: true,
      },
    })),
  };
}

export function adaptLegacyFilterParamsToAst({
  filterParams,
  targetGranularity = "PRODUCT",
  source = "LEGACY_FILTER_PARAMS",
} = {}) {
  if (!Array.isArray(filterParams)) {
    throw new TargetingValidationError("LEGACY_FILTER_INVALID", {
      code: "LEGACY_FILTER_INVALID",
    });
  }
  const normalizedGranularity =
    TARGET_GRANULARITIES[targetGranularity] || TARGET_GRANULARITIES.PRODUCT;

  const children = filterParams.map((f, index) => {
    const field = mapLegacyFieldAlias(f?.field);
    if (field === "search") {
      return buildLegacySearchGroup(f, index);
    }
    const operator = mapLegacyOperatorAlias(f?.operator);
    return {
      nodeType: "predicate",
      field,
      operator,
      value: normalizeLegacyRawValue(f?.value, operator),
      meta: {
        ...extractLegacyMeta(f),
        legacyIndex: index,
      },
    };
  });

  return {
    version: FILTER_AST_VERSION,
    root: {
      nodeType: "group",
      logic: "AND",
      children,
    },
    options: {
      targetGranularity: normalizedGranularity,
    },
    context: {
      source,
    },
  };
}
