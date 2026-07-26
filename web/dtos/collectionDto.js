// web/dtos/collectionDto.js

function getCanonicalCollectionId(collection) {
  return collection?.shopifyId || collection?.id || null;
}

export function toCollectionOptionDto(collection) {
  const id = getCanonicalCollectionId(collection);

  if (!id || !collection?.title) return null;

  return Object.freeze({
    id,
    value: id,
    label: collection.title,
    title: collection.title,
    handle: collection.handle || null,
  });
}

export function toCollectionOptionListDto(collections) {
  if (!Array.isArray(collections)) return [];

  return collections.map(toCollectionOptionDto).filter(Boolean);
}

export function toCollectionDto(collection) {
  const id = getCanonicalCollectionId(collection);

  if (!id || !collection?.title) return null;

  return Object.freeze({
    id,
    shopifyId: collection.shopifyId || id,
    title: collection.title,
    handle: collection.handle || null,
  });
}

export function toCollectionListDto(collections) {
  if (!Array.isArray(collections)) return [];

  return collections.map(toCollectionDto).filter(Boolean);
}

export function toCollectionRefreshAcceptedDto(result) {
  return Object.freeze({
    operationId: result?.operationId || null,
    status: result?.status || "ACCEPTED",
  });
}

export function toCollectionResponseDto(result, options = {}) {
  const collections = result?.collections || result?.data || [];
  const mode = options.isNameOnly ? "OPTION" : "LIST";

  const data =
    mode === "OPTION"
      ? toCollectionOptionListDto(collections)
      : toCollectionListDto(collections);

  const nextCursor =
    typeof result?.nextCursor === "string" ? result.nextCursor : null;

  return Object.freeze({
    success: true,
    data,
    meta: Object.freeze({
      contract:
        mode === "OPTION"
          ? "collectionOptionListResponseDto"
          : "collectionListResponseDto",
      source: result?.source || "MIRROR",
      returnedCount: data.length,
      nextCursor,
      hasNextPage: Boolean(result?.hasNextPage),
      totalCount:
        typeof result?.totalCount === "number" ? result.totalCount : null,
      stale: Boolean(result?.stale),
    }),
  });
}
