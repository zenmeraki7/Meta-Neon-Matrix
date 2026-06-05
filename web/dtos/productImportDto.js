const MAX_STRING_LENGTH = 10_000;
const MAX_SHORT_STRING_LENGTH = 255;
const MAX_MESSAGE_LENGTH = 1_000;
const MAX_PREVIEW_ROWS = 250;
const MAX_COLUMNS = 300;
const MAX_TAGS = 250;
const MAX_METAFIELDS_PER_ROW = 100;
const MAX_ROW_MESSAGES = 100;

const SAFE_PREVIEW_ROW_KEYS = Object.freeze([
  "rowNumber",
  "externalId",
  "productId",
  "variantId",
  "handle",
  "sku",

  "title",
  "vendor",
  "productType",
  "status",
  "tags",
  "descriptionHtml",

  "price",
  "compareAtPrice",
  "barcode",
  "inventoryQuantity",
  "inventoryPolicy",
  "taxable",
  "requiresShipping",

  "option1Name",
  "option1Value",
  "option2Name",
  "option2Value",
  "option3Name",
  "option3Value",

  "metafields",

  "action",
  "valid",
  "errors",
  "warnings",
]);

const SAFE_COLUMN_KEYS = Object.freeze([
  "index",
  "header",
  "normalizedHeader",
  "mappedField",
  "required",
  "supported",
  "errorCode",
  "warningCode",
]);

const SAFE_ROW_MESSAGE_KEYS = Object.freeze([
  "rowNumber",
  "column",
  "field",
  "code",
  "message",
]);

function isPlainObject(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Date),
  );
}

function truncateString(value, maxLength = MAX_STRING_LENGTH) {
  const stringValue = String(value);

  if (stringValue.length <= maxLength) {
    return stringValue;
  }

  return stringValue.slice(0, maxLength);
}

function safeString(value, fallback = null, maxLength = MAX_STRING_LENGTH) {
  if (value === undefined || value === null) return fallback;
  return truncateString(value, maxLength);
}

function safeNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeInteger(value, fallback = null, { min = null, max = null } = {}) {
  const number = Number(value);

  if (!Number.isInteger(number)) {
    return fallback;
  }

  if (min !== null && number < min) {
    return fallback;
  }

  if (max !== null && number > max) {
    return fallback;
  }

  return number;
}

function safeBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  return fallback;
}

function safeDate(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeArray(value, maxItems) {
  if (!Array.isArray(value)) return [];
  return Number.isInteger(maxItems) ? value.slice(0, maxItems) : value;
}

function safePlainObject(value) {
  return isPlainObject(value) ? value : {};
}

function pickAllowedKeys(source, allowedKeys) {
  const safeSource = safePlainObject(source);
  const output = {};

  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(safeSource, key)) {
      output[key] = safeSource[key];
    }
  }

  return output;
}

function normalizeScalarPreviewValue(value) {
  if (value === undefined || value === null) return null;

  if (typeof value === "string") {
    return safeString(value);
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (value instanceof Date) {
    return safeDate(value);
  }

  return safeString(value);
}

function normalizeTags(value) {
  if (Array.isArray(value)) {
    return safeArray(value, MAX_TAGS)
      .map((tag) => safeString(tag, null, MAX_SHORT_STRING_LENGTH))
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .slice(0, MAX_TAGS)
      .map((tag) => safeString(tag.trim(), null, MAX_SHORT_STRING_LENGTH))
      .filter(Boolean);
  }

  return [];
}

function normalizeMetafields(value) {
  return safeArray(value, MAX_METAFIELDS_PER_ROW)
    .map((item) => {
      const metafield = safePlainObject(item);

      return {
        namespace: safeString(metafield.namespace, "", MAX_SHORT_STRING_LENGTH),
        key: safeString(metafield.key, "", MAX_SHORT_STRING_LENGTH),
        type: safeString(metafield.type, "", MAX_SHORT_STRING_LENGTH),
        value: normalizeScalarPreviewValue(metafield.value),
      };
    })
    .filter((metafield) => metafield.namespace && metafield.key);
}

function normalizeRowMessage(message, fallbackCode, fallbackMessage) {
  const safeMessage = pickAllowedKeys(message, SAFE_ROW_MESSAGE_KEYS);

  return {
    rowNumber: safeInteger(safeMessage.rowNumber),
    column: safeString(safeMessage.column, null, MAX_SHORT_STRING_LENGTH),
    field: safeString(safeMessage.field, null, MAX_SHORT_STRING_LENGTH),
    code: safeString(safeMessage.code, fallbackCode, MAX_SHORT_STRING_LENGTH),
    message: safeString(
      safeMessage.message,
      fallbackMessage,
      MAX_MESSAGE_LENGTH,
    ),
  };
}

function normalizeRowErrors(errors) {
  return safeArray(errors, MAX_ROW_MESSAGES).map((error) =>
    normalizeRowMessage(error, "CSV_ROW_INVALID", "Invalid CSV row"),
  );
}

function normalizeRowWarnings(warnings) {
  return safeArray(warnings, MAX_ROW_MESSAGES).map((warning) =>
    normalizeRowMessage(warning, "CSV_ROW_WARNING", "CSV row warning"),
  );
}

function normalizePreviewRow(row) {
  const safeRow = pickAllowedKeys(row, SAFE_PREVIEW_ROW_KEYS);

  return {
    rowNumber: safeInteger(safeRow.rowNumber),
    externalId: safeString(safeRow.externalId, null, MAX_SHORT_STRING_LENGTH),
    productId: safeString(safeRow.productId, null, MAX_SHORT_STRING_LENGTH),
    variantId: safeString(safeRow.variantId, null, MAX_SHORT_STRING_LENGTH),
    handle: safeString(safeRow.handle, null, MAX_SHORT_STRING_LENGTH),
    sku: safeString(safeRow.sku, null, MAX_SHORT_STRING_LENGTH),

    title: safeString(safeRow.title),
    vendor: safeString(safeRow.vendor, null, MAX_SHORT_STRING_LENGTH),
    productType: safeString(safeRow.productType, null, MAX_SHORT_STRING_LENGTH),
    status: safeString(safeRow.status, null, 100),
    tags: normalizeTags(safeRow.tags),

    // API DTO only returns the string. Frontend must sanitize before HTML rendering.
    descriptionHtml: safeString(safeRow.descriptionHtml),

    price: safeString(safeRow.price, null, 100),
    compareAtPrice: safeString(safeRow.compareAtPrice, null, 100),
    barcode: safeString(safeRow.barcode, null, MAX_SHORT_STRING_LENGTH),
    inventoryQuantity: safeInteger(safeRow.inventoryQuantity),
    inventoryPolicy: safeString(safeRow.inventoryPolicy, null, 100),
    taxable: safeBoolean(safeRow.taxable),
    requiresShipping: safeBoolean(safeRow.requiresShipping),

    option1Name: safeString(safeRow.option1Name, null, MAX_SHORT_STRING_LENGTH),
    option1Value: safeString(safeRow.option1Value, null, MAX_SHORT_STRING_LENGTH),
    option2Name: safeString(safeRow.option2Name, null, MAX_SHORT_STRING_LENGTH),
    option2Value: safeString(safeRow.option2Value, null, MAX_SHORT_STRING_LENGTH),
    option3Name: safeString(safeRow.option3Name, null, MAX_SHORT_STRING_LENGTH),
    option3Value: safeString(safeRow.option3Value, null, MAX_SHORT_STRING_LENGTH),

    metafields: normalizeMetafields(safeRow.metafields),

    action: safeString(safeRow.action, null, 100),
    valid: safeBoolean(safeRow.valid, true),
    errors: normalizeRowErrors(safeRow.errors),
    warnings: normalizeRowWarnings(safeRow.warnings),
  };
}

function normalizePreviewRows(rows) {
  return safeArray(rows, MAX_PREVIEW_ROWS).map(normalizePreviewRow);
}

function normalizeCsvItems(rows) {
  return safeArray(rows, MAX_PREVIEW_ROWS).map((row) => {
    const safeRow = safePlainObject(row);
    const output = {};

    for (const [key, value] of Object.entries(safeRow).slice(0, MAX_COLUMNS)) {
      const safeKey = safeString(key, null, MAX_SHORT_STRING_LENGTH);
      if (safeKey) output[safeKey] = normalizeScalarPreviewValue(value);
    }

    return output;
  });
}

function normalizeHeaders(headers) {
  return safeArray(headers, MAX_COLUMNS)
    .map((header) => safeString(header, null, 500))
    .filter(Boolean);
}

function normalizePageInfo(pageInfo) {
  const safePageInfo = safePlainObject(pageInfo);

  return {
    hasNextPage: safeBoolean(safePageInfo.hasNextPage),
    hasPreviousPage: safeBoolean(safePageInfo.hasPreviousPage),
    nextCursor: safeString(safePageInfo.nextCursor, null, 1_000),
    previousCursor: safeString(safePageInfo.previousCursor, null, 1_000),
  };
}

function normalizeColumn(column, fallbackIndex) {
  if (typeof column === "string") {
    return {
      index: fallbackIndex,
      header: safeString(column, "", 500),
      normalizedHeader: null,
      mappedField: null,
      required: false,
      supported: true,
      errorCode: null,
      warningCode: null,
    };
  }

  const safeColumn = pickAllowedKeys(column, SAFE_COLUMN_KEYS);

  return {
    index: safeInteger(safeColumn.index, fallbackIndex),
    header: safeString(safeColumn.header, "", 500),
    normalizedHeader: safeString(safeColumn.normalizedHeader, null, 500),
    mappedField: safeString(safeColumn.mappedField, null, MAX_SHORT_STRING_LENGTH),
    required: safeBoolean(safeColumn.required),
    supported: safeBoolean(safeColumn.supported, true),
    errorCode: safeString(safeColumn.errorCode, null, MAX_SHORT_STRING_LENGTH),
    warningCode: safeString(
      safeColumn.warningCode,
      null,
      MAX_SHORT_STRING_LENGTH,
    ),
  };
}

function normalizeColumns(columns) {
  return safeArray(columns, MAX_COLUMNS).map((column, index) =>
    normalizeColumn(column, index),
  );
}

function normalizeSummary(summary) {
  const safeSummary = safePlainObject(summary);

  return {
    totalRows: safeInteger(safeSummary.totalRows, 0, { min: 0 }),
    acceptedRows: safeInteger(safeSummary.acceptedRows, 0, { min: 0 }),
    rejectedRows: safeInteger(safeSummary.rejectedRows, 0, { min: 0 }),
    estimatedCreates: safeInteger(safeSummary.estimatedCreates, 0, { min: 0 }),
    estimatedUpdates: safeInteger(safeSummary.estimatedUpdates, 0, { min: 0 }),
    estimatedVariantUpdates: safeInteger(
      safeSummary.estimatedVariantUpdates,
      0,
      { min: 0 },
    ),
    estimatedNoops: safeInteger(safeSummary.estimatedNoops, 0, { min: 0 }),
  };
}

function resolvePreviewId(result) {
  return (
    result?.previewId ||
    result?.csvPreviewId ||
    result?.uploadToken ||
    result?.id ||
    null
  );
}

function buildCsvPreviewData(result) {
  const previewId = resolvePreviewId(result);
  const items = normalizeCsvItems(result?.items || result?.rows || result?.previewRows);

  return {
    previewId: safeString(previewId, null, MAX_SHORT_STRING_LENGTH),
    status: safeString(result?.status || "READY", "READY", 100),
    items,
    headers: normalizeHeaders(result?.headers),
    pageInfo: normalizePageInfo(result?.pageInfo),
    totalCount: safeInteger(result?.totalCount, items.length, { min: 0 }),
    columns: normalizeColumns(result?.columns),
    rows: normalizePreviewRows(result?.previewRows || result?.rows),
    rowCount: safeInteger(result?.rowCount, 0, { min: 0 }),
    hasMore: safeBoolean(result?.hasMore),
    nextCursor: safeString(result?.nextCursor, null, 1_000),
    createdAt: safeDate(result?.createdAt),
    expiresAt: safeDate(result?.expiresAt),
  };
}

function buildCsvPreviewPageData(result) {
  const previewId = resolvePreviewId(result);
  const items = normalizeCsvItems(result?.items || result?.rows || result?.previewRows);

  return {
    previewId: safeString(previewId, null, MAX_SHORT_STRING_LENGTH),
    status: safeString(result?.status || "READY", "READY", 100),
    items,
    headers: normalizeHeaders(result?.headers),
    pageInfo: normalizePageInfo(result?.pageInfo),
    totalCount: safeInteger(result?.totalCount, items.length, { min: 0 }),
    rows: normalizePreviewRows(result?.rows || result?.previewRows),
    columns: normalizeColumns(result?.columns),
    rowCount: safeInteger(result?.rowCount, 0, { min: 0 }),
    pageSize: safeInteger(result?.pageSize || result?.limit, 0, { min: 0 }),
    hasMore: safeBoolean(result?.hasMore),
    nextCursor: safeString(result?.nextCursor, null, 1_000),
  };
}

export function toProductImportAcceptedDto(result) {
  return {
    success: true,
    data: {
      operationId: safeString(
        result?.operationId,
        null,
        MAX_SHORT_STRING_LENGTH,
      ),
      importId: safeString(
        result?.importId || result?.id,
        null,
        MAX_SHORT_STRING_LENGTH,
      ),
      previewId: safeString(
        result?.previewId || result?.csvPreviewId,
        null,
        MAX_SHORT_STRING_LENGTH,
      ),
      status: safeString(result?.status || "QUEUED", "QUEUED", 100),
      queuedAt: safeDate(result?.queuedAt || result?.createdAt),
      acceptedAt: safeDate(result?.acceptedAt || result?.createdAt),
      summary: normalizeSummary(result?.summary),
    },
  };
}

export function toCsvPreviewDto(result) {
  const data = buildCsvPreviewData(result);

  return {
    success: true,
    data,

    // Temporary compatibility fields.
    uploadToken: data.previewId,
    items: data.items,
    headers: data.headers,
    pageInfo: data.pageInfo,
    totalCount: data.totalCount,
    previewRows: data.rows,
  };
}

export function toCsvPreviewPageDto(result) {
  const data = buildCsvPreviewPageData(result);

  return {
    success: true,
    data,

    // Temporary compatibility fields.
    uploadToken: data.previewId,
    items: data.items,
    headers: data.headers,
    pageInfo: data.pageInfo,
    totalCount: data.totalCount,
    rows: data.rows,
  };
}

export function toCsvPreviewResponseDto(result) {
  return {
    statusCode: result?.durable ? 202 : 200,
    body: toCsvPreviewDto(result),
  };
}

export default {
  toProductImportAcceptedDto,
  toCsvPreviewDto,
  toCsvPreviewPageDto,
  toCsvPreviewResponseDto,
};
