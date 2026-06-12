import { canonicalizeFilters, buildCanonicalFilterHash } from "../list/hooks/useProducts";

const MIN_PRODUCT_SEARCH_LENGTH = 2;

function safeString(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim();
  return normalized || fallback;
}

export function buildProductTargetingContract({
  filters = [],
  searchQuery = "",
  sort = null,
  selectionMode = "filtered",
  selectedProductIds = [],
  excludedProductIds = [],
} = {}) {
  const baseFilters = Array.isArray(filters)
    ? filters.filter((filter) => filter?.field !== "search")
    : [];
  const normalizedSearch = safeString(searchQuery, "");
  const effectiveFilters =
    normalizedSearch.length >= MIN_PRODUCT_SEARCH_LENGTH
      ? [
          ...baseFilters,
          {
            field: "search",
            operator: "contains",
            value: normalizedSearch,
          },
        ]
      : baseFilters;
  const canonicalFilters = canonicalizeFilters(effectiveFilters);

  return Object.freeze({
    searchQuery: normalizedSearch,
    filters: canonicalFilters,
    sort: sort || null,
    selectionMode: selectionMode === "selected" ? "selected" : "filtered",
    selectedProductIds: Array.isArray(selectedProductIds)
      ? selectedProductIds.map(String).filter(Boolean)
      : [],
    excludedProductIds: Array.isArray(excludedProductIds)
      ? excludedProductIds.map(String).filter(Boolean)
      : [],
    filterHash: buildCanonicalFilterHash(canonicalFilters),
  });
}

export function resolveProductTargetingContract({
  navigationState,
  filters = [],
  searchQuery = "",
} = {}) {
  const candidate = navigationState?.productTargeting;

  if (candidate && Array.isArray(candidate.filters)) {
    return buildProductTargetingContract(candidate);
  }

  return buildProductTargetingContract({ filters, searchQuery });
}
