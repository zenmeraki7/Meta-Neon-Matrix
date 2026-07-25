import { productExportFieldRegistry } from "../services/productService/productExportFieldRegistry.js";

const MAX_ERROR_LIST_LENGTH = 100;
const MAX_ERROR_MESSAGE_LENGTH = 300;
const MAX_VALUE_STRING_LENGTH = 1000;
const MAX_TEXT_LENGTH = 300;
const MAX_TITLE_LENGTH = 200;
const MAX_URL_LENGTH = 2000;

const EXPORT_FIELD_LABEL_BY_KEY = new Map(
  productExportFieldRegistry.map((field) => [
    field.key,
    field.label || field.key,
  ])
);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function parseArrayString(value) {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

function normalizeExportFieldKeys(value) {
  const rawFields = Array.isArray(value)
    ? value
    : parseArrayString(value) || [];

  return rawFields
    .map((field) => {
      if (typeof field === "string") return field.trim();
      const safe = asObject(field);
      return toStringOrNull(safe?.key ?? safe?.value ?? safe?.field, 160);
    })
    .filter(Boolean);
}

function toExportedFieldDtos(value) {
  const rawFields = Array.isArray(value)
    ? value
    : parseArrayString(value) || [];

  return rawFields
    .map((field) => {
      const safe = asObject(field);
      const key =
        typeof field === "string"
          ? field.trim()
          : toStringOrNull(safe?.key ?? safe?.value ?? safe?.field, 160);
      if (!key) return null;

      return {
        key,
        label:
          toSafeText(safe?.label, MAX_TITLE_LENGTH) ||
          EXPORT_FIELD_LABEL_BY_KEY.get(key) ||
          key,
      };
    })
    .filter(Boolean);
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
          MAX_ERROR_MESSAGE_LENGTH
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

function toExportHistoryListItemDto(history) {
  const safe = asObject(history) || {};
  const status = toStringOrNull(safe.statusNormalized ?? safe.status, 120);
  const downloadUrl = toSafeText(
    safe.downloadUrl ?? safe.downloadUrl,
    MAX_URL_LENGTH
  );
  const totalItems = toNumber(safe.totalItems ?? safe.totalRows, 0);

  return {
    id: toStringOrNull(safe.id, 200),
    type: toStringOrNull(safe.type, 120),
    rawType: toStringOrNull(safe.rawType ?? safe.type, 120),
    status,
    statusNormalized: status,
    fileName: toSafeText(safe.fileName ?? safe.filename, 255),
    filename: toSafeText(safe.filename ?? safe.fileName, 255),
    format: toStringOrNull(safe.format, 80),
    createdAt: toIsoString(safe.createdAt),
    completedAt: toIsoString(safe.completedAt),
    totalItems,
    totalRows: totalItems,
    successCount: toNumber(safe.successCount, 0),
    failedCount: toNumber(safe.failedCount, 0),
    processedCount: toNumber(safe.processedCount, 0),
    progressPercent: toNumber(safe.progressPercent, 0),
    primaryStatus: asObject(safe.primaryStatus),
    progressSummary: asObject(safe.progressSummary),
    supportStatus: asObject(safe.supportStatus),
    downloadReady: status === "COMPLETED" && Boolean(downloadUrl),
    downloadUrl,
  };
}

function toExportHistoryDetailDto(history) {
  const safe = asObject(history) || {};
  const status = toStringOrNull(safe.statusNormalized ?? safe.status, 120);
  const executionState = toStringOrNull(
    safe.executionStateNormalized ?? safe.executionState,
    120
  );
  const downloadUrl = toSafeText(
    safe.downloadUrl ?? safe.downloadUrl,
    MAX_URL_LENGTH
  );
  const totalItems = toNumber(safe.totalItems ?? safe.totalRows, 0);
  const fields = normalizeExportFieldKeys(
    safe.fields ?? safe.selectedFields ?? safe.exportFields ?? safe.columns
  );
  const exportedFields = toExportedFieldDtos(
    safe.exportedFields && safe.exportedFields.length
      ? safe.exportedFields
      : fields
  );

  return {
    id: toStringOrNull(safe.id, 200),
    exportJobId: toStringOrNull(safe.exportJobId ?? safe.id, 200),
    type: toStringOrNull(safe.type, 120),
    rawType: toStringOrNull(safe.rawType ?? safe.type, 120),
    status,
    statusLabel: status,
    statusNormalized: status,
    executionState,
    executionStateNormalized: executionState,
    targetGranularity: toStringOrNull(safe.targetGranularity, 80),
    fileName: toSafeText(safe.fileName ?? safe.filename, 255),
    filename: toSafeText(safe.filename ?? safe.fileName, 255),
    format: toStringOrNull(safe.format, 80),
    createdAt: toIsoString(safe.createdAt),
    queuedAt: toIsoString(safe.queuedAt ?? safe.createdAt),
    startedAt: toIsoString(safe.startedAt),
    completedAt: toIsoString(safe.completedAt),
    failedAt:
      status === "FAILED"
        ? toIsoString(safe.completedAt ?? safe.updatedAt)
        : null,
    totalItems,
    totalRows: totalItems,
    rowCount: totalItems,
    processedCount: toNumber(safe.processedCount, 0),
    progressPercent: toNumber(safe.progressPercent, 0),
    targetSnapshotCount: toNumber(safe.targetSnapshotCount, 0),
    durationMs: toNumber(safe.durationMs, 0),
    fields,
    exportedFields,
    successCount: toNumber(safe.successCount, 0),
    failedCount: toNumber(safe.failedCount, 0),
    downloadReady: status === "COMPLETED" && Boolean(downloadUrl),
    downloadUrl,
    errors: toSafeErrorList(safe.errors),
    error: safe.error ?? null,
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
    shop: toStringOrNull(safe.shop, 200),
    createdAt: toIsoString(safe.createdAt),
    updatedAt: toIsoString(safe.updatedAt),
    completedAt: toIsoString(safe.completedAt),
    totalCount: toNumber(safe.totalCount ?? safe.totalItems, 0),
    totalItems: toNumber(safe.totalItems, 0),
    processedCount: toNumber(safe.processedCount, 0),
    progressProcessedCount: toNumber(safe.progressProcessedCount, 0),
    successCount: toNumber(safe.successCount, 0),
    failedCount: toNumber(safe.failedCount, 0),
    undoStatus: toStringOrNull(safe.undoStatus, 120),
    primaryStatus: asObject(safe.primaryStatus),
    undoStatusSummary: asObject(safe.undoStatusSummary),
    progressSummary: asObject(safe.progressSummary),
    timelineSummary: asObject(safe.timelineSummary),
  };
}

function toEditHistoryDetailDto(history) {
  const safe = asObject(history) || {};

  return {
    id: toStringOrNull(safe.id, 200),
    type: toStringOrNull(safe.type ?? safe.editType, 120),
    status: toStringOrNull(safe.status, 120),
    statusNormalized: toStringOrNull(safe.statusNormalized, 120),
    executionState: toStringOrNull(safe.executionState, 120),
    executionStateNormalized: toStringOrNull(
      safe.executionStateNormalized,
      120
    ),
    title: toSafeText(safe.title ?? safe.name, MAX_TITLE_LENGTH),
    field: toStringOrNull(safe.field, 160),
    createdAt: toIsoString(safe.createdAt),
    updatedAt: toIsoString(safe.updatedAt),
    completedAt: toIsoString(safe.completedAt),
    totalCount: toNumber(safe.totalCount ?? safe.totalItems, 0),
    totalItems: toNumber(safe.totalItems, 0),
    processedCount: toNumber(safe.processedCount, 0),
    progressCount: toNumber(safe.progressCount, 0),
    progressProcessedCount: toNumber(safe.progressProcessedCount, 0),
    targetSnapshotCount: toNumber(safe.targetSnapshotCount, 0),
    durationMs: toNumber(safe.durationMs, 0),
    successCount: toNumber(safe.successCount, 0),
    failedCount: toNumber(safe.failedCount, 0),
    skippedCount: toNumber(safe.skippedCount, 0),
    primaryStatus: asObject(safe.primaryStatus),
    undoStatusSummary: asObject(safe.undoStatusSummary),
    progressSummary: asObject(safe.progressSummary),
    merchantSafetyState: toStringOrNull(safe.merchantSafetyState, 160),
    displayStatus: toStringOrNull(safe.displayStatus, 120),
    supportStatus: asObject(safe.supportStatus),
    timelineSummary: asObject(safe.timelineSummary),
    executionTransparency: asObject(safe.executionTransparency),
    snapshotReference: asObject(safe.snapshotReference),
    undo: asObject(safe.undo),
    undoStatus: toStringOrNull(safe.undoStatus, 120),
    summary: asObject(safe.summary)
      ? toEditHistoryEmbeddedSummaryDto(safe.summary)
      : null,
    error: safe.error ?? null,
    errors: toSafeErrorList(safe.errors || safe.error),
  };
}

function toEditHistorySummaryDto(summary) {
  const safe = asObject(summary) || {};
  const rawType = toStringOrNull(safe.type ?? safe.editType, 120);
  const type =
    rawType && rawType.toLowerCase() === "manual edit" ? "edit" : rawType;

  return {
    id: toStringOrNull(safe.id, 200),
    type,
    status: toStringOrNull(safe.status, 120),
    statusNormalized: toStringOrNull(safe.statusNormalized, 120),
    executionState: toStringOrNull(safe.executionState, 120),
    executionStateNormalized: toStringOrNull(
      safe.executionStateNormalized,
      120
    ),
    title: toSafeText(safe.title ?? safe.name, MAX_TITLE_LENGTH),
    createdAt: toIsoString(safe.createdAt),
    updatedAt: toIsoString(safe.updatedAt),
    completedAt: toIsoString(safe.completedAt),
    totalCount: toNumber(safe.totalCount ?? safe.totalItems, 0),
    totalItems: toNumber(safe.totalItems, 0),
    processedCount: toNumber(safe.processedCount, 0),
    progressCount: toNumber(safe.progressCount, 0),
    progressProcessedCount: toNumber(safe.progressProcessedCount, 0),
    targetSnapshotCount: toNumber(safe.targetSnapshotCount, 0),
    durationMs: toNumber(safe.durationMs, 0),
    successCount: toNumber(safe.successCount, 0),
    failedCount: toNumber(safe.failedCount, 0),
    skippedCount: toNumber(safe.skippedCount, 0),
    primaryStatus: asObject(safe.primaryStatus),
    undoStatusSummary: asObject(safe.undoStatusSummary),
    progressSummary: asObject(safe.progressSummary),
    merchantSafetyState: toStringOrNull(safe.merchantSafetyState, 160),
    displayStatus: toStringOrNull(safe.displayStatus, 120),
    supportStatus: asObject(safe.supportStatus),
    timelineSummary: asObject(safe.timelineSummary),
    executionTransparency: asObject(safe.executionTransparency),
    snapshotReference: asObject(safe.snapshotReference),
    undo: asObject(safe.undo),
    error: safe.error ?? null,
    undoStatus: toStringOrNull(safe.undoStatus, 120),
  };
}

function toEditHistoryChangeDto(change) {
  const safe = asObject(change) || {};
  const rawUndoResult = asObject(safe.undoResult);
  const undoResult = rawUndoResult
    ? {
        status: toStringOrNull(rawUndoResult.status, 80),
        verified: rawUndoResult.verified === true,
        verifiedAt: toIsoString(rawUndoResult.verifiedAt),
        fields: asArray(rawUndoResult.fields)
          .slice(0, 100)
          .map((entry) => {
            const field = asObject(entry) || {};
            return {
              scope: toStringOrNull(field.changeScope, 40),
              field: toStringOrNull(field.field, 160),
              productId: toStringOrNull(field.productId, 200),
              variantId: toStringOrNull(field.variantId, 200),
              restoredValue: toDisplayValue(field.restoredValue),
              currentShopifyValue: toDisplayValue(field.currentShopifyValue),
              verified: field.verified === true,
              verifiedAt: toIsoString(field.verifiedAt),
            };
          }),
        errorCode: toStringOrNull(rawUndoResult.errorCode, 160),
        errorMessage: toSafeText(
          rawUndoResult.errorMessage,
          MAX_ERROR_MESSAGE_LENGTH
        ),
      }
    : null;

  return {
    id: toStringOrNull(safe.id, 200),
    title: toSafeText(safe.title, MAX_TITLE_LENGTH),
    image: toSafeText(safe.image, MAX_URL_LENGTH),
    productId: toStringOrNull(safe.productId, 200),
    variantId: toStringOrNull(safe.variantId, 200),
    productFieldChanges: asArray(safe.productFieldChanges),
    variantFieldChanges: asArray(safe.variantFieldChanges),
    field: toStringOrNull(safe.field ?? safe.fieldName, 160),
    beforeValue: toDisplayValue(safe.beforeValue),
    afterValue: toDisplayValue(safe.afterValue),
    status: toStringOrNull(safe.status, 120),
    errorMessage: toSafeText(
      safe.publicError ?? safe.errorMessage,
      MAX_ERROR_MESSAGE_LENGTH
    ),
    undoResult,
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
  const currentPage = toNumber(safe.currentPage ?? safe.page, 1) || 1;
  const totalCount = toNumber(safe.totalCount, 0);
  const limit = toNumber(safe.limit, changes.length || 1) || 1;

  return {
    success: true,
    data: changes.map(toEditHistoryChangeDto),
    meta: {
      count: changes.length,
      totalCount,
      currentPage,
      totalPages: Math.max(1, Math.ceil(totalCount / Math.max(limit, 1))),
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
  const histories = historiesFromContract.length
    ? historiesFromContract
    : fallbackItems;

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
