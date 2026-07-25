function getCategoryId(category) {
  return category?.id || null;
}

function assertCanonicalCategoryServiceResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    const error = new Error("Invalid category service result shape");
    error.code = "INTERNAL_ERROR";
    throw error;
  }

  if (!Array.isArray(result.categories)) {
    const error = new Error("Invalid category service result: categories must be an array");
    error.code = "INTERNAL_ERROR";
    throw error;
  }

  if (result.pageInfo !== null && typeof result.pageInfo !== "object" && result.pageInfo !== undefined) {
    const error = new Error("Invalid category service result: pageInfo must be object|null");
    error.code = "INTERNAL_ERROR";
    throw error;
  }

  if (result.source !== undefined && typeof result.source !== "string") {
    const error = new Error("Invalid category service result: source must be string");
    error.code = "INTERNAL_ERROR";
    throw error;
  }
}

export function toCategoryDto(category) {
  const id = getCategoryId(category);
  const title = category?.fullName || category?.name || null;
  if (!id || !title) return null;

  return {
    id,
    title,
    label: title,
    value: id,
  };
}

export function toCategoryOptionDto(category) {
  const id = getCategoryId(category);
  const label = category?.name || category?.fullName || null;
  if (!id || !label) return null;

  return {
    id,
    label,
    title: label,
    value: id,
  };
}

export function toCategoryListDto(categories) {
  if (!Array.isArray(categories)) return [];
  return categories.map(toCategoryDto).filter(Boolean);
}

export function toCategoryOptionListDto(categories) {
  if (!Array.isArray(categories)) return [];
  return categories.map(toCategoryOptionDto).filter(Boolean);
}

export function toCategoryListResponseDto(result, options = {}) {
  assertCanonicalCategoryServiceResult(result);
  const categories = result.categories;
  const data = toCategoryListDto(categories);

  return {
    success: true,
    data,
    meta: {
      search: options?.search || null,
      returnedCount: data.length,
      pageInfo: result?.pageInfo || null,
      source: result?.source || "CATEGORY_SERVICE",
      contract: "categoryListResponseDto",
    },
  };
}

export function toCategoryOptionResponseDto(result, options = {}) {
  assertCanonicalCategoryServiceResult(result);
  const categories = result.categories;
  const data = toCategoryOptionListDto(categories);

  return {
    success: true,
    data,
    meta: {
      search: options?.search || null,
      returnedCount: data.length,
      pageInfo: result?.pageInfo || null,
      source: result?.source || "CATEGORY_SERVICE",
      contract: "categoryOptionListResponseDto",
    },
  };
}
