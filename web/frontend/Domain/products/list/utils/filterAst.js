const AST_VERSION = "2.0.0";

const TARGET_GRANULARITIES = new Set([
  "PRODUCT",
  "VARIANT",
  "PRODUCT_WITH_MATCHING_VARIANTS",
  "INVENTORY",
  "COLLECTION",
]);

const VALUELESS_OPERATORS = new Set([
  "IS_EMPTY",
  "IS_NOT_EMPTY",
]);

const RELATIVE_DAY_OPERATORS = new Set([
  "GT_RELATIVE_DAYS",
  "LT_RELATIVE_DAYS",
]);

const TEXT_OPERATORS = new Set([
  "EQ",
  "NEQ",
  "EQ_CI",
  "EQ_CS",
  "CONTAINS",
  "CONTAINS_CI",
  "CONTAINS_CS",
  "NOT_CONTAINS",
  "NOT_CONTAINS_CI",
  "NOT_CONTAINS_CS",
  "STARTS_WITH",
  "NOT_STARTS_WITH",
  "ENDS_WITH",
  "CONTAINS_ANY_WORDS",
  "IS_EMPTY",
  "IS_NOT_EMPTY",
]);

const NUMBER_OPERATORS = new Set([
  "EQ",
  "NEQ",
  "LT",
  "LTE",
  "GT",
  "GTE",
  "IS_EMPTY",
  "IS_NOT_EMPTY",
]);

const DATE_OPERATORS = new Set([
  "EQ",
  "NEQ",
  "LT",
  "LTE",
  "GT",
  "GTE",
  "GT_RELATIVE_DAYS",
  "LT_RELATIVE_DAYS",
  "IS_EMPTY",
  "IS_NOT_EMPTY",
]);

const ENUM_OPERATORS = new Set([
  "EQ",
  "NEQ",
  "IS_EMPTY",
  "IS_NOT_EMPTY",
]);

const BOOLEAN_OPERATORS = new Set([
  "EQ",
  "NEQ",
  "IS_EMPTY",
  "IS_NOT_EMPTY",
]);

const OPERATOR_MAP = Object.freeze({
  // Equality
  "=": "EQ",
  "==": "EQ",
  IS: "EQ",
  EQUALS: "EQ",
  EQUAL: "EQ",
  EQ: "EQ",
  EQUALS_CI: "EQ_CI",
  EQUALS_CS: "EQ_CS",
  EQ_CI: "EQ_CI",
  EQ_CS: "EQ_CS",

  IS_NOT: "NEQ",
  "IS NOT": "NEQ",
  "!=": "NEQ",
  "<>": "NEQ",
  "DOES NOT EQUAL": "NEQ",
  DOES_NOT_EQUAL: "NEQ",
  NOT_EQUALS: "NEQ",
  NOT_EQUAL: "NEQ",
  NOT_EQ: "NEQ",
  NEQ: "NEQ",

  // Text
  CONTAINS: "CONTAINS",
  CONTAINS_CI: "CONTAINS_CI",
  CONTAINS_CS: "CONTAINS_CS",
  NOT_CONTAINS: "NOT_CONTAINS",
  NOT_CONTAINS_CI: "NOT_CONTAINS_CI",
  NOT_CONTAINS_CS: "NOT_CONTAINS_CS",
  "DOES NOT CONTAIN": "NOT_CONTAINS",
  DOES_NOT_CONTAIN: "NOT_CONTAINS",

  STARTS_WITH: "STARTS_WITH",
  "STARTS WITH": "STARTS_WITH",
  NOT_STARTS_WITH: "NOT_STARTS_WITH",
  "DOES NOT START WITH": "NOT_STARTS_WITH",
  DOES_NOT_START_WITH: "NOT_STARTS_WITH",

  ENDS_WITH: "ENDS_WITH",
  "ENDS WITH": "ENDS_WITH",
  CONTAINS_ANY_WORDS: "CONTAINS_ANY_WORDS",

  // Numeric/date comparison
  "<": "LT",
  LT: "LT",
  LESS_THAN: "LT",
  BEFORE: "LT",
  "IS BEFORE": "LT",
  IS_BEFORE: "LT",

  "<=": "LTE",
  LTE: "LTE",
  LESS_THAN_OR_EQUAL: "LTE",
  ON_OR_BEFORE: "LTE",

  ">": "GT",
  GT: "GT",
  GREATER_THAN: "GT",
  AFTER: "GT",
  "IS AFTER": "GT",
  IS_AFTER: "GT",

  ">=": "GTE",
  GTE: "GTE",
  GREATER_THAN_OR_EQUAL: "GTE",
  ON_OR_AFTER: "GTE",

  IS_AFTER_DAYS: "GT_RELATIVE_DAYS",
  AFTER_DAYS: "GT_RELATIVE_DAYS",
  IS_BEFORE_DAYS: "LT_RELATIVE_DAYS",
  BEFORE_DAYS: "LT_RELATIVE_DAYS",

  // Empty / blank
  IS_EMPTY: "IS_EMPTY",
  "IS EMPTY": "IS_EMPTY",
  IS_BLANK: "IS_EMPTY",
  "IS EMPTY/BLANK": "IS_EMPTY",
  IS_EMPTY_OR_BLANK: "IS_EMPTY",

  IS_NOT_EMPTY: "IS_NOT_EMPTY",
  "IS NOT EMPTY": "IS_NOT_EMPTY",
  IS_NOT_BLANK: "IS_NOT_EMPTY",
  "IS NOT EMPTY/BLANK": "IS_NOT_EMPTY",
  IS_NOT_EMPTY_OR_BLANK: "IS_NOT_EMPTY",
});

function normalizeOperatorKey(operator) {
  return String(operator ?? "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function mapOperatorToAst(operator) {
  const raw = normalizeOperatorKey(operator);

  if (!raw) {
    throw new Error("Filter operator is required");
  }

  const mapped = OPERATOR_MAP[raw];

  if (!mapped) {
    throw new Error(`Unsupported filter operator: ${operator}`);
  }

  return mapped;
}

function isValidFieldName(field) {
  return /^[a-zA-Z][a-zA-Z0-9_.:-]*$/.test(field);
}

function getFieldDefinition(field, fieldTypes = {}) {
  const definition = fieldTypes[field];

  if (!definition) {
    return { type: "text" };
  }

  if (typeof definition === "string") {
    return { type: definition };
  }

  if (typeof definition === "object") {
    return {
      type: definition.type || "text",
      ...definition,
    };
  }

  return { type: "text" };
}

function normalizePrimitiveValue(value, fieldDefinition) {
  if (typeof value !== "string") return value;

  const fieldType = fieldDefinition.type || "text";
  const trimmed = value.trim();

  if (trimmed === "") return null;

  switch (fieldType) {
    case "number": {
      if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
        throw new Error(`Invalid numeric filter value: ${value}`);
      }

      const numericValue = Number(trimmed);

      if (!Number.isFinite(numericValue)) {
        throw new Error(`Invalid numeric filter value: ${value}`);
      }

      if (fieldDefinition.integer && !Number.isInteger(numericValue)) {
        throw new Error(`Filter value for "${fieldDefinition.label || "field"}" must be an integer`);
      }

      if (
        typeof fieldDefinition.min === "number" &&
        numericValue < fieldDefinition.min
      ) {
        throw new Error(`Filter value is below minimum ${fieldDefinition.min}`);
      }

      if (
        typeof fieldDefinition.max === "number" &&
        numericValue > fieldDefinition.max
      ) {
        throw new Error(`Filter value is above maximum ${fieldDefinition.max}`);
      }

      return numericValue;
    }

    case "boolean": {
      const lower = trimmed.toLowerCase();

      if (lower === "true") return true;
      if (lower === "false") return false;

      throw new Error(`Invalid boolean filter value: ${value}`);
    }

    case "date":
    case "text":
    case "enum":
    default:
      return trimmed;
  }
}

function normalizeAstValue(value, fieldDefinition) {
  if (value === undefined || value === null) return null;

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeAstValue(entry, fieldDefinition));
  }

  if (typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = normalizeAstValue(value[key], fieldDefinition);
        return acc;
      }, {});
  }

  return normalizePrimitiveValue(value, fieldDefinition);
}

function isDeepEmpty(value) {
  if (value === null || value === undefined || value === "") return true;

  if (Array.isArray(value)) {
    return value.length === 0 || value.every(isDeepEmpty);
  }

  if (typeof value === "object") {
    const values = Object.values(value);
    return values.length === 0 || values.every(isDeepEmpty);
  }

  return false;
}

function validateOperatorForFieldType({ field, operator, fieldType }) {
  const allowedByType = {
    text: TEXT_OPERATORS,
    number: NUMBER_OPERATORS,
    date: DATE_OPERATORS,
    enum: ENUM_OPERATORS,
    boolean: BOOLEAN_OPERATORS,
  };

  const allowed = allowedByType[fieldType] || TEXT_OPERATORS;

  if (!allowed.has(operator)) {
    throw new Error(
      `Operator "${operator}" is not valid for ${fieldType} filter "${field}"`,
    );
  }
}

function validateAllowedValues({ field, value, fieldDefinition }) {
  const allowedValues = fieldDefinition.allowedValues;

  if (!Array.isArray(allowedValues) || allowedValues.length === 0) {
    return;
  }

  const values = Array.isArray(value) ? value : [value];
  const allowed = new Set(allowedValues.map((entry) => String(entry)));

  for (const entry of values) {
    if (!allowed.has(String(entry))) {
      throw new Error(`Invalid value "${entry}" for filter "${field}"`);
    }
  }
}

function validatePredicateValue({ field, operator, value }) {
  if (VALUELESS_OPERATORS.has(operator)) {
    return;
  }

  if (isDeepEmpty(value)) {
    throw new Error(`Filter "${field}" requires a non-empty value for operator "${operator}"`);
  }

  if (RELATIVE_DAY_OPERATORS.has(operator)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        `Filter "${field}" requires a non-negative integer day value for operator "${operator}"`,
      );
    }
  }
}

function normalizeTargetGranularity(targetGranularity) {
  const normalized = String(targetGranularity || "PRODUCT").trim().toUpperCase();

  if (!TARGET_GRANULARITIES.has(normalized)) {
    throw new Error(`Unsupported target granularity: ${targetGranularity}`);
  }

  return normalized;
}

function normalizeSource(source) {
  const normalized = String(source || "FRONTEND_BUILDER").trim().toUpperCase();

  if (!/^[A-Z0-9_:-]+$/.test(normalized)) {
    throw new Error(`Invalid AST source: ${source}`);
  }

  return normalized;
}

export function buildFilterAstFromLegacyFilters({
  rawFilterInput = [],
  targetGranularity = "PRODUCT",
  source = "FRONTEND_BUILDER",
  fieldTypes = {},
  strict = true,
} = {}) {
  if (!Array.isArray(rawFilterInput)) {
    if (strict) {
      throw new Error("rawFilterInput must be an array");
    }

    rawFilterInput = [];
  }

  const normalizedTargetGranularity =
    normalizeTargetGranularity(targetGranularity);
  const normalizedSource = normalizeSource(source);

  const children = rawFilterInput
    .map((filter, index) => {
      const field = String(filter?.field ?? "").trim();

      if (!field) {
        if (strict) {
          throw new Error(`Filter at index ${index} is missing field`);
        }

        return null;
      }

      if (!isValidFieldName(field)) {
        throw new Error(`Invalid filter field: ${field}`);
      }

      const operator = mapOperatorToAst(filter?.operator);
      const fieldDefinition = getFieldDefinition(field, fieldTypes);
      const fieldType = fieldDefinition.type || "text";

      validateOperatorForFieldType({
        field,
        operator,
        fieldType,
      });

      const predicate = {
        nodeType: "predicate",
        field,
        operator,
        meta: {
          legacyIndex: index,
          fieldType,
        },
      };

      if (!VALUELESS_OPERATORS.has(operator)) {
        const valueDefinition = RELATIVE_DAY_OPERATORS.has(operator)
          ? { ...fieldDefinition, type: "number", integer: true, min: 0 }
          : fieldDefinition;

        const value = normalizeAstValue(filter?.value, valueDefinition);

        validatePredicateValue({
          field,
          operator,
          value,
        });

        validateAllowedValues({
          field,
          value,
          fieldDefinition,
        });

        predicate.value = value;
      }

      return predicate;
    })
    .filter(Boolean);

  return {
    version: AST_VERSION,
    root: {
      nodeType: "group",
      logic: "AND",
      children,
    },
    options: {
      targetGranularity: normalizedTargetGranularity,
    },
    context: {
      source: normalizedSource,
    },
  };
}
