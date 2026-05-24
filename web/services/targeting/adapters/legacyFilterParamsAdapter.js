import { FILTER_AST_VERSION } from "../versioning.js";
import { TargetingValidationError } from "../errors/TargetingValidationError.js";
import { TARGET_GRANULARITIES } from "../types.js";
import { fieldRegistry } from "../registry/fieldRegistry.js";
import { operatorRegistry } from "../registry/operatorRegistry.js";

function mapLegacyFieldAlias(field) {
  const raw = String(field || "").trim();
  const aliasMap = {
    product_type: "productType",
    productType: "productType",
    vendor_name: "vendor",
    stock: "inventoryQuantity",
    inventory: "inventoryQuantity",
  };

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
    NEQ: "NEQ",
    CONTAINS: "CONTAINS",
    NOT_CONTAINS: "NOT_CONTAINS",
    STARTS_WITH: "STARTS_WITH",
    ENDS_WITH: "ENDS_WITH",
    IN: "IN",
    NOT_IN: "NOT_IN",
    LT: "LT",
    LESS_THAN: "LT",
    LTE: "LTE",
    LESS_THAN_OR_EQUAL: "LTE",
    GT: "GT",
    GREATER_THAN: "GT",
    GTE: "GTE",
    GREATER_THAN_OR_EQUAL: "GTE",
    BETWEEN: "BETWEEN",
    IS_EMPTY: "IS_EMPTY",
    IS_NOT_EMPTY: "IS_NOT_EMPTY",
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

function normalizeLegacyRawValue(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.toLowerCase() === "true") return true;
  if (trimmed.toLowerCase() === "false") return false;
  if (trimmed === "") return null;
  return trimmed;
}

function extractLegacyMeta(filter) {
  const { field, operator, value, ...rest } = filter || {};
  return rest;
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
    const operator = mapLegacyOperatorAlias(f?.operator);
    return {
      nodeType: "predicate",
      field,
      operator,
      value: normalizeLegacyRawValue(f?.value, f),
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
