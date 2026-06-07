const MAX_ERROR_LIST_LENGTH = 100;
const MAX_ERROR_MESSAGE_LENGTH = 300;
const MAX_VALUE_STRING_LENGTH = 1000;
const MAX_TEXT_LENGTH = 300;
const MAX_TITLE_LENGTH = 200;
const MAX_URL_LENGTH = 2000;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toIsoString(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  return null;
}

function toSafeText(value, maxLength = MAX_TEXT_LENGTH) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function toStringOrNull(value, maxLength = MAX_TEXT_LENGTH) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "string") {
    return toSafeText(value, maxLength);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return toSafeText(String(value), maxLength);
  }

  return null;
}

function toDisplayValue(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "string") {
    return toSafeText(value, MAX_VALUE_STRING_LENGTH);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (value instanceof Date) {
    return toIsoString(value);
  }

  return "[complex value]";
}

function toPageInfoDto(value) {
  const safe = asObject(value) || {};

  return {
    hasNextPage: Boolean(safe.hasNextPage),
    hasPreviousPage: Boolean(safe.hasPreviousPage),
    startCursor: toStringOrNull(safe.startCursor, 500),
    endCursor: toStringOrNull(safe.endCursor, 500),
  };
}

function toSafeErrorList(value) {
  return asArray(value)
    .slice(0, MAX_ERROR_LIST_LENGTH)
    .map((item) => {
      const safe = asObject(item) || {};

      return {
        code: toStringOrNull(safe.code, 80),
        message: toSafeText(
          safe.publicMessage ?? safe.message,
          MAX_ERROR_MESSAGE_LENGTH,
        ),
        row: toNumber(safe.row, 0) || null,
        field: toStringOrNull(safe.field, 120),
      };
    });
}

function toEditHistoryEmbeddedSummaryDto(summary) {
  const safe = asObject(summary) || {};

  return {
    totalCount: toNumber(safe.totalCount ?? safe.totalItems, 0),
    successCount: toNumber(safe.successCount, 0),
    failedCount: toNumber(safe.failedCount, 0),
    skippedCount: toNumber(safe.skippedCount, 0),
  };
}

function toStatusSummaryDto(value) {
  const safe = asObject(value);
  if (!safe) return null;
  return {
    key: toStringOrNull(safe.key, 80),
    label: toSafeText(safe.label, 160),
    tone: toStringOrNull(safe.tone, 40),
    detail: toSafeText(safe.detail, 500),
    isTerminal: safe.isTerminal === true,
  };
}

function toDegradationDto(value) {
  const safe = asObject(value);
  if (!safe) return null;
  return {
    code: toStringOrNull(safe.code, 80),
    title: toSafeText(safe.title, 200),
    body: toSafeText(safe.body, 600),
    showRetryAt: safe.showRetryAt === true,
    retryAt: toIsoString(safe.retryAt),
    recoveryWindow: toSafeText(safe.recoveryWindow, 200),
  };
}

function toEditSupportStatusDto(value) {
  const safe = asObject(value);
  if (!safe) return null;
  return {
    executionState: toStringOrNull(safe.executionState, 80),
    failureStage: toStringOrNull(safe.failureStage, 160),
    undoState: toStringOrNull(safe.undoState, 80),
    degradation: toDegradationDto(safe.degradation),
  };
}

function toExportHistoryListItemDto(history) {
  const safe = asObject(history) || {};

  return {
    id: toStringOrNull(safe.id, 200),
    type: toStringOrNull(safe.type, 120),
    status: toStringOrNull(safe.status, 120),
    fileName: toSafeText(safe.fileName ?? safe.filename, 255),
    format: toStringOrNull(safe.format, 80),
    createdAt: toIsoString(safe.createdAt),
    completedAt: toIsoString(safe.completedAt),
    totalRows: toNumber(safe.totalRows, 0),
    successCount: toNumber(safe.successCount, 0),
    failedCount: toNumber(safe.failedCount, 0),
    downloadUrl: toSafeText(safe.downloadUrl ?? safe.fileUrl, MAX_URL_LENGTH),
  };
}

function toExportHistoryDetailDto(history) {
  const safe = asObject(history) || {};

  return {
    id: toStringOrNull(safe.id, 200),
    type: toStringOrNull(safe.type, 120),
    status: toStringOrNull(safe.status, 120),
    fileName: toSafeText(safe.fileName ?? safe.filename, 255),
    format: toStringOrNull(safe.format, 80),
    createdAt: toIsoString(safe.createdAt),
    completedAt: toIsoString(safe.completedAt),
    totalRows: toNumber(safe.totalRows, 0),
    successCount: toNumber(safe.successCount, 0),
    failedCount: toNumber(safe.failedCount, 0),
    downloadUrl: toSafeText(safe.downloadUrl ?? safe.fileUrl, MAX_URL_LENGTH),
    errors: toSafeErrorList(safe.errors),
  };
}

export function toExportHistoryListResponseDto(result) {
  const safe = asObject(result) || {};
  const items = asArray(safe.items);

  return {
    success: true,
    data: items.map(toExportHistoryListItemDto),
    meta: {
      count: items.length,
      totalCount: toNumber(safe.totalCount, 0),
      pageInfo: toPageInfoDto(safe.pageInfo),
    },
  };
}

export function toExportHistoryDetailResponseDto(result) {
  return {
    success: true,
    data: toExportHistoryDetailDto(result),
  };
}

function unwrapEdge(edgeOrNode) {
  const safe = asObject(edgeOrNode) || {};
  return asObject(safe.node) || safe;
}

function toEditHistoryListItemDto(edgeOrHistory) {
  const edge = asObject(edgeOrHistory) || {};
  const safe = unwrapEdge(edgeOrHistory);

  return {
    cursor: toStringOrNull(edge.cursor ?? safe.cursor, 500),
    id: toStringOrNull(safe.id, 200),
    type: toStringOrNull(safe.type ?? safe.editType, 120),
    status: toStringOrNull(safe.status, 120),
    title: toSafeText(safe.title ?? safe.name, MAX_TITLE_LENGTH),
    createdAt: toIsoString(safe.createdAt),
    completedAt: toIsoString(safe.completedAt),
    totalCount: toNumber(safe.totalCount ?? safe.totalItems, 0),
    successCount: toNumber(safe.successCount, 0),
    failedCount: toNumber(safe.failedCount, 0),
    undoStatus: toStringOrNull(safe.undoStatus, 120),
    primaryStatus: toStatusSummaryDto(safe.primaryStatus),
    undoStatusSummary: toStatusSummaryDto(safe.undoStatusSummary),
    supportStatus: toEditSupportStatusDto(safe.supportStatus),
  };
}

function toEditHistoryDetailDto(history) {
  const safe = asObject(history) || {};

  return {
    id: toStringOrNull(safe.id, 200),
    type: toStringOrNull(safe.type ?? safe.editType, 120),
    status: toStringOrNull(safe.status, 120),
    title: toSafeText(safe.title ?? safe.name, MAX_TITLE_LENGTH),
    createdAt: toIsoString(safe.createdAt),
    completedAt: toIsoString(safe.completedAt),
    totalCount: toNumber(safe.totalCount ?? safe.totalItems, 0),
    successCount: toNumber(safe.successCount, 0),
    failedCount: toNumber(safe.failedCount, 0),
    undoStatus: toStringOrNull(safe.undoStatus, 120),
    summary: asObject(safe.summary)
      ? toEditHistoryEmbeddedSummaryDto(safe.summary)
      : null,
    errors: toSafeErrorList(safe.errors),
    primaryStatus: toStatusSummaryDto(safe.primaryStatus),
    undoStatusSummary: toStatusSummaryDto(safe.undoStatusSummary),
    supportStatus: toEditSupportStatusDto(safe.supportStatus),
    progressSummary: asObject(safe.progressSummary),
  };
}

function toEditHistorySummaryDto(summary) {
  const safe = asObject(summary) || {};

  return {
    id: toStringOrNull(safe.id, 200),
    type: toStringOrNull(safe.type ?? safe.editType, 120),
    status: toStringOrNull(safe.status, 120),
    title: toSafeText(safe.title ?? safe.name, MAX_TITLE_LENGTH),
    createdAt: toIsoString(safe.createdAt),
    completedAt: toIsoString(safe.completedAt),
    totalCount: toNumber(safe.totalCount ?? safe.totalItems, 0),
    successCount: toNumber(safe.successCount, 0),
    failedCount: toNumber(safe.failedCount, 0),
    skippedCount: toNumber(safe.skippedCount, 0),
    undoStatus: toStringOrNull(safe.undoStatus, 120),
    primaryStatus: toStatusSummaryDto(safe.primaryStatus),
    undoStatusSummary: toStatusSummaryDto(safe.undoStatusSummary),
    supportStatus: toEditSupportStatusDto(safe.supportStatus),
    progressSummary: asObject(safe.progressSummary),
  };
}

function toEditHistoryChangeDto(change) {
  const safe = asObject(change) || {};

  return {
    id: toStringOrNull(safe.id, 200),
    productId: toStringOrNull(safe.productId, 200),
    variantId: toStringOrNull(safe.variantId, 200),
    field: toStringOrNull(safe.field ?? safe.fieldName, 160),
    beforeValue: toDisplayValue(safe.beforeValue),
    afterValue: toDisplayValue(safe.afterValue),
    status: toStringOrNull(safe.status, 120),
    errorMessage: toSafeText(
      safe.publicError ?? safe.errorMessage,
      MAX_ERROR_MESSAGE_LENGTH,
    ),
    createdAt: toIsoString(safe.createdAt),
  };
}

export function toEditHistoryListResponseDto(result) {
  const safe = asObject(result) || {};
  const edges = asArray(safe.edges);

  return {
    success: true,
    data: edges.map(toEditHistoryListItemDto),
    meta: {
      count: edges.length,
      totalCount: toNumber(safe.totalCount, 0),
      pageInfo: toPageInfoDto(safe.pageInfo),
      planLimit: toNumber(safe.planLimit, 0) || null,
    },
  };
}

export function toEditHistoryDetailResponseDto(result) {
  return {
    success: true,
    data: toEditHistoryDetailDto(result),
  };
}

export function toEditHistorySummaryResponseDto(result) {
  return {
    success: true,
    data: toEditHistorySummaryDto(result),
  };
}

export function toEditHistoryChangesResponseDto(result) {
  const safe = asObject(result) || {};
  const changes = asArray(safe.changes);

  return {
    success: true,
    data: changes.map(toEditHistoryChangeDto),
    meta: {
      count: changes.length,
      totalCount: toNumber(safe.totalCount, 0),
      pageInfo: toPageInfoDto(safe.pageInfo),
    },
  };
}

function toImportHistoryListItemDto(history) {
  const safe = asObject(history) || {};

  return {
    id: toStringOrNull(safe.id, 200),
    status: toStringOrNull(safe.status, 120),
    fileName: toSafeText(safe.fileName, 255),
    createdAt: toIsoString(safe.createdAt),
    completedAt: toIsoString(safe.completedAt),
    totalRows: toNumber(safe.totalRows, 0),
    successCount: toNumber(safe.successCount, 0),
    failedCount: toNumber(safe.failedCount, 0),
  };
}

function toImportHistoryDetailDto(history) {
  const safe = asObject(history) || {};

  return {
    id: toStringOrNull(safe.id, 200),
    status: toStringOrNull(safe.status, 120),
    fileName: toSafeText(safe.fileName, 255),
    createdAt: toIsoString(safe.createdAt),
    completedAt: toIsoString(safe.completedAt),
    totalRows: toNumber(safe.totalRows, 0),
    successCount: toNumber(safe.successCount, 0),
    failedCount: toNumber(safe.failedCount, 0),
    errors: toSafeErrorList(safe.errors),
  };
}

export function toImportHistoryListResponseDto(result) {
  const safe = asObject(result) || {};
  const historiesFromContract = asArray(safe.histories);
  const fallbackItems = asArray(safe.items);
  const histories = historiesFromContract.length ? historiesFromContract : fallbackItems;

  return {
    success: true,
    data: histories.map(toImportHistoryListItemDto),
    meta: {
      count: histories.length,
      totalCount: toNumber(safe.totalCount, 0),
      pageInfo: toPageInfoDto(safe.pageInfo),
    },
  };
}

export function toImportHistoryDetailResponseDto(result) {
  return {
    success: true,
    data: toImportHistoryDetailDto(result),
  };
}
