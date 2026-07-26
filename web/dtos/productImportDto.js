/**
 * DTO mappers for Product Import and CSV Preview endpoints.
 * Strictly whitelists public API fields and redacts internal storage paths,
 * outbox IDs, queue payloads, and database fields.
 */

export function toProductImportAcceptedDto(result = {}) {
  return Object.freeze({
    ok: true,
    success: true,
    operationId: result.operationId || null,
    importId: result.importId || result.operationId || null,
    status: result.status || "QUEUED",
  });
}

export function toCsvPreviewAcceptedDto(result = {}) {
  return Object.freeze({
    ok: true,
    success: true,
    uploadToken: result.uploadToken || null,
    status: result.status || "QUEUED",
  });
}

export function toCsvPreviewPageDto(result = {}) {
  return Object.freeze({
    ok: true,
    success: true,
    items: Array.isArray(result.items) ? result.items : [],
    headers: Array.isArray(result.headers) ? result.headers : [],
    pageInfo: {
      hasNextPage: Boolean(result.pageInfo?.hasNextPage),
      hasPreviousPage: Boolean(result.pageInfo?.hasPreviousPage),
      nextCursor: result.pageInfo?.nextCursor || null,
      previousCursor: result.pageInfo?.previousCursor || null,
    },
    totalCount: Number.isFinite(result.totalCount) ? result.totalCount : 0,
  });
}
