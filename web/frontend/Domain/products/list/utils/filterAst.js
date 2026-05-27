function mapOperatorToAst(operator) {
  const raw = String(operator || "").trim().toUpperCase();
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

export function buildFilterAstFromLegacyFilters({
  filterParams = [],
  targetGranularity = "PRODUCT",
  source = "FRONTEND_BUILDER",
} = {}) {
  const children = Array.isArray(filterParams)
    ? filterParams
        .map((filter, index) => {
          if (!filter?.field) return null;
          return {
            nodeType: "predicate",
            field: String(filter.field),
            operator: mapOperatorToAst(filter.operator),
            value: normalizeValue(filter.value),
            meta: {
              legacyIndex: index,
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
