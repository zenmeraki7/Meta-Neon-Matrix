function mapOperatorToAst(operator, field) {
  const raw = String(operator || "").trim().toUpperCase();
  const normalizedField = String(field || "").trim();
  if (
    (normalizedField === "collections" || normalizedField === "tags") &&
    (raw === "IS" || raw === "EQUALS" || raw === "=" || raw === "==")
  ) {
    return "IN";
  }
  const map = {
    "=": "EQ",
    "==": "EQ",
    "IS": "EQ",
    "EQUALS": "EQ",
    "!=": "NEQ",
    "<>": "NEQ",
    "IS NOT": "NEQ",
    "DOES NOT EQUAL": "NEQ",
    "CONTAINS": "CONTAINS",
    "DOES NOT CONTAIN": "NOT_CONTAINS",
    "STARTS WITH": "STARTS_WITH",
    "ENDS WITH": "ENDS_WITH",
    "<": "LT",
    "<=": "LTE",
    ">": "GT",
    ">=": "GTE",
    "IS EMPTY": "IS_EMPTY",
    "IS EMPTY/BLANK": "IS_EMPTY",
    "IS NOT EMPTY": "IS_NOT_EMPTY",
    "IS BEFORE": "LT",
    "IS AFTER": "GT",
  };

  return map[raw] || raw;
}

function normalizeValue(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.toLowerCase() === "true") return true;
  if (trimmed.toLowerCase() === "false") return false;
  return trimmed;
}

function normalizeAstValue(field, operator, value) {
  const normalized = normalizeValue(value);
  if (
    (field === "collections" || field === "tags") &&
    (operator === "IN" || operator === "NOT_IN")
  ) {
    if (normalized === null || normalized === undefined) return [];
    return Array.isArray(normalized) ? normalized : [normalized];
  }
  return normalized;
}

export function buildFilterAstFromLegacyFilters({
  filterParams = [],
  targetGranularity = "PRODUCT",
  source = "FRONTEND_BUILDER",
} = {}) {
  const children = Array.isArray(filterParams)
    ? filterParams
        .map((filter, index) => {
          if (!filter?.field) return null;
          const field = String(filter.field);
          const operator = mapOperatorToAst(filter.operator, field);
          return {
            nodeType: "predicate",
            field,
            operator,
            value: normalizeAstValue(field, operator, filter.value),
            meta: {
              legacyIndex: index,
              ...(filter.namespace ? { namespace: filter.namespace } : {}),
              ...(filter.key ? { key: filter.key } : {}),
            },
          };
        })
        .filter(Boolean)
    : [];

  return {
    version: "2.0.0",
    root: {
      nodeType: "group",
      logic: "AND",
      children,
    },
    options: {
      targetGranularity,
    },
    context: {
      source,
    },
  };
}
