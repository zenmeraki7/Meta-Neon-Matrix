const TARGET_QUERY_PARAM = "target";
const MAX_TARGET_FILTERS = 500;
const MAX_TARGET_FIELD_LENGTH = 160;
const MAX_TARGET_OPERATOR_LENGTH = 160;
const MAX_TARGET_VALUE_LENGTH = 5000;

function normalizeTargetValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return value;
  throw new Error("Invalid filter value");
}

function normalizeTargetFilter(filter, index) {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
    throw new Error(`Invalid filter at ${index + 1}`);
  }

  const field = String(filter.field || "").trim();
  const operator = String(filter.operator || "").trim();
  const value = normalizeTargetValue(filter.value);

  if (!field || field.length > MAX_TARGET_FIELD_LENGTH) {
    throw new Error(`Invalid filter field at ${index + 1}`);
  }
  if (!operator || operator.length > MAX_TARGET_OPERATOR_LENGTH) {
    throw new Error(`Invalid filter operator at ${index + 1}`);
  }
  if (typeof value === "string" && value.length > MAX_TARGET_VALUE_LENGTH) {
    throw new Error(`Invalid filter value at ${index + 1}`);
  }

  return { field, operator, value };
}

export function normalizeEditTargetFilters(filters = []) {
  if (!Array.isArray(filters)) {
    throw new Error("Invalid target filters");
  }
  if (filters.length > MAX_TARGET_FILTERS) {
    throw new Error("Too many target filters");
  }
  return filters.map(normalizeTargetFilter);
}

export function buildEditTargetSearch(filters = []) {
  const filterParams = normalizeEditTargetFilters(filters);
  if (filterParams.length === 0) return "";

  const params = new URLSearchParams();
  params.set(TARGET_QUERY_PARAM, JSON.stringify({ filterParams }));
  return `?${params.toString()}`;
}

export function parseEditTargetSearch(search = "") {
  const params = new URLSearchParams(search || "");
  const rawTarget = params.get(TARGET_QUERY_PARAM);

  if (!rawTarget) {
    return {
      hasTarget: false,
      filterParams: [],
      error: null,
    };
  }

  try {
    const parsed = JSON.parse(rawTarget);
    return {
      hasTarget: true,
      filterParams: normalizeEditTargetFilters(parsed?.filterParams || []),
      error: null,
    };
  } catch (error) {
    return {
      hasTarget: true,
      filterParams: [],
      error: error?.message || "Invalid target filters",
    };
  }
}
