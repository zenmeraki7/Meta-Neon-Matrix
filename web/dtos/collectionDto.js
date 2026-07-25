function getCanonicalCollectionId(collection) {
  return collection?.shopifyId || null;
}

export function toCollectionOptionDto(collection) {
  const id = getCanonicalCollectionId(collection);

  if (!id || !collection?.title) return null;

  return {
    id,
    value: id,
    label: collection.title,
    title: collection.title,
    handle: collection.handle || null,
  };
}

export function toCollectionOptionListDto(collections) {
  if (!Array.isArray(collections)) return [];

  return collections.map(toCollectionOptionDto).filter(Boolean);
}

export function toCollectionDto(collection) {
  const id = getCanonicalCollectionId(collection);

  if (!id || !collection?.title) return null;

  return {
    id,
    shopifyId: collection.shopifyId || id,
    title: collection.title,
    handle: collection.handle || null,
  };
}

export function toCollectionListDto(collections) {
  if (!Array.isArray(collections)) return [];

  return collections.map(toCollectionDto).filter(Boolean);
}

export function toCollectionRefreshAcceptedDto(result) {
  return {
    operationId: result?.operationId || null,
    status: result?.status || "ACCEPTED",
  };
}

export function toCollectionResponseDto(result, options = {}) {
  const collections = result?.collections || result?.data || [];
  const mode = options.isNameOnly ? "OPTION" : "LIST";

  const data =
    mode === "OPTION"
      ? toCollectionOptionListDto(collections)
      : toCollectionListDto(collections);

  return {
    success: true,
    data,
    meta: {
      contract: mode === "OPTION" ? "collectionOptionListResponseDto" : "collectionListResponseDto",
      source: result?.source || "MIRROR",
      returnedCount: data.length,
      pageInfo: result?.pageInfo || null,
      stale: Boolean(result?.stale),
    },
  };
}
