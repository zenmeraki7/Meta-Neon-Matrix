//web/frontend/Domain/products/list/utils/filterUtils.js


const VALUE_OPTION_OPERATORS = new Set([
  "contains",
  "does not contain",
  "equals",
  "does not equal",
  "starts with",
  "ends with",
  "is",
  "is not",
  "<",
  "<=",
  ">",
  ">=",
  "=",
  "!=",
  "is before",
  "is after",
  "between",
]);

const VALUELESS_OPERATORS = new Set([
  "is empty",
  "is empty/blank",
  "is not empty",
  "exists",
  "not_exists",
]);

const OPERATOR_TRANSLATION_KEY_MAP = {
  contains: "filtersOperators.contains",
  "does not contain": "filtersOperators.doesNotContain",
  equals: "filtersOperators.equals",
  "does not equal": "filtersOperators.doesNotEqual",
  "starts with": "filtersOperators.startsWith",
  "ends with": "filtersOperators.endsWith",
  "is empty/blank": "filtersOperators.isEmptyBlank",
  "is not empty": "filtersOperators.isNotEmpty",
  "is before": "filtersOperators.isBefore",
  "is after": "filtersOperators.isAfter",
  is: "filtersOperators.is",
  "is not": "filtersOperators.isNot",
  "<": "filtersOperators.lessThan",
  ">": "filtersOperators.greaterThan",
  "=": "filtersOperators.equalTo",
  "!=": "filtersOperators.notEqualTo",
};
export function operatorRequiresValue(operator) {
  const normalized = String(operator || "").trim().toLowerCase();
  if (VALUELESS_OPERATORS.has(normalized)) return false;
  return VALUE_OPTION_OPERATORS.has(normalized);
}

export function getTranslatedOperatorLabel(t, operator) {
  const key = OPERATOR_TRANSLATION_KEY_MAP[operator];
  return key ? t(key) : operator;
}

export function normalizeAutocompleteOption(item) {
  if (item === null || item === undefined) return null;

  if (typeof item === "string" || typeof item === "number") {
    const normalized = String(item).trim();
    if (!normalized) return null;

    return {
      label: normalized,
      value: normalized,
    };
  }

  const label = item.label ?? item.title ?? item.name ?? item.value ?? item.id;
  const value = item.value ?? item.title ?? item.name ?? item.label ?? item.id;

  if (label === undefined || value === undefined) {
    return null;
  }

  const normalizedLabel = String(label).trim();
  const normalizedValue = String(value).trim();

  if (!normalizedLabel || !normalizedValue) {
    return null;
  }

  return {
    label: normalizedLabel,
    value: normalizedValue,
  };
}

export function normalizeFilterValueForSubmit(filter, value) {
  const rawValue = value == null ? "" : String(value).trim();

  if (filter?.key === "status") {
    return rawValue.toUpperCase();
  }

  if (filter?.type === "number") {
    return rawValue;
  }

  return rawValue;
}

export function isFilterDraftValid(filter, draft) {
  const operator = String(draft?.operator || "").trim();
  if (!filter?.key || !operator) return false;

  if (!operatorRequiresValue(operator)) {
    return true;
  }

  const normalizedValue = normalizeFilterValueForSubmit(filter, draft?.value);
  if (!normalizedValue) return false;

  if (filter?.type === "number") {
    return Number.isFinite(Number(normalizedValue));
  }

  if (filter?.type === "date") {
    const date = new Date(normalizedValue);
    return Number.isFinite(date.getTime());
  }

  if (filter?.type === "enum" && Array.isArray(filter.values) && filter.values.length > 0) {
    return filter.values
      .map((entry) => String(entry).trim().toLowerCase())
      .includes(String(normalizedValue).trim().toLowerCase());
  }

  return true;
}
