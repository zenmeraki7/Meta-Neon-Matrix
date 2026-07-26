// web/dtos/productBulkEditDto.js

const MAX_VARIANT_SAMPLE = 20;
const MAX_DISPLAY_TEXT = 180;

function safeString(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim();
  return normalized || fallback;
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toDisplayValue(value) {
  if (value === null || value === undefined) {
    return {
      displayText: "-",
      rawType: "string",
      truncated: false,
      inspectable: false,
    };
  }

  if (typeof value === "string") {
    return {
      displayText:
        value.length > MAX_DISPLAY_TEXT
          ? `${value.slice(0, MAX_DISPLAY_TEXT)}...`
          : value,
      rawType: "string",
      truncated: value.length > MAX_DISPLAY_TEXT,
      inspectable: false,
    };
  }

  if (typeof value === "number") {
    return {
      displayText: String(value),
      rawType: "number",
      truncated: false,
      inspectable: false,
    };
  }

  if (typeof value === "boolean") {
    return {
      displayText: value ? "true" : "false",
      rawType: "boolean",
      truncated: false,
      inspectable: false,
    };
  }

  if (Array.isArray(value)) {
    const preview = value.slice(0, 4).map((item) => safeString(item, String(item)));
    const displayText = `[${preview.join(", ")}${value.length > 4 ? ", ..." : ""}]`;
    return {
      displayText,
      rawType: "list",
      truncated: value.length > 4,
      inspectable: true,
    };
  }

  if (typeof value === "object") {
    const displayText = safeString(
      value.displayText ?? value.text ?? value.label ?? value.value,
      "[complex value]",
    );
    const rawType = safeString(value.rawType, "json");
    return {
      displayText:
        displayText.length > MAX_DISPLAY_TEXT
          ? `${displayText.slice(0, MAX_DISPLAY_TEXT)}...`
          : displayText,
      rawType,
      truncated: displayText.length > MAX_DISPLAY_TEXT,
      inspectable: rawType === "json" || rawType === "reference",
    };
  }

  return {
    displayText: safeString(value, "-"),
    rawType: "string",
    truncated: false,
    inspectable: false,
  };
}

function displayTextOf(value) {
  return toDisplayValue(value).displayText;
}

function mapVariantSample(variants) {
  if (!Array.isArray(variants) || variants.length === 0) return [];
  return variants.slice(0, MAX_VARIANT_SAMPLE).map((variant, index) => ({
    variantId: safeString(variant?.variantId || variant?.id, "") || `variant-${index + 1}`,
    title: safeString(variant?.title, `Variant ${index + 1}`),
    oldValue: toDisplayValue(variant?.oldValue),
    newValue: toDisplayValue(variant?.newValue),
    status: safeString(variant?.status, "READY"),
    warning: safeString(variant?.warning, "") || null,
  }));
}

function mapPreviewRows(rawRows) {
  if (!Array.isArray(rawRows)) return [];

  return rawRows.map((row, index) => {
    const variants = Array.isArray(row?.variants) ? row.variants : [];
    const variantCount = safeNumber(row?.variantCount, variants.length);
    return {
      productId: safeString(row?.productId || row?.id, "") || `preview-${index + 1}`,
      variantId: safeString(row?.variantId, "") || undefined,
      handle: safeString(row?.handle, "") || undefined,
      title: safeString(row?.title, "Untitled product"),
      imageUrl: row?.img || row?.imageUrl || null,
      oldValue: toDisplayValue(row?.oldValue),
      newValue: toDisplayValue(row?.newValue),
      variants: mapVariantSample(variants),
      variantCount,
      changedVariantCount: safeNumber(row?.changedVariantCount, 0),
      hasVariantDetails:
        row?.hasVariantDetails === true || variantCount > 0 || variants.length > 0,
    };
  });
}

function mapVariantLevelRows(productRows) {
  if (!Array.isArray(productRows)) return [];

  return productRows.flatMap((productRow) => {
    const variants = Array.isArray(productRow?.variants) ? productRow.variants : [];
    return variants.map((variant) => ({
      productId: safeString(productRow?.productId, ""),
      variantId: safeString(variant?.variantId, ""),
      productTitle: safeString(productRow?.title, "Untitled product"),
      variantTitle: safeString(variant?.title, "Default Title"),
      currentValue: displayTextOf(variant?.oldValue),
      newValue: displayTextOf(variant?.newValue),
      status: safeString(variant?.status, "READY"),
      warning: safeString(variant?.warning, "") || null,
    }));
  });
}

export function toBulkEditPreviewResponseDto(result) {
  const data = result?.data || {};
  const pagination = data?.pagination || {};
  const rows = mapPreviewRows(data?.preview);
  const isVariant = Boolean(data?.isVariant);
  const responseRows = isVariant ? mapVariantLevelRows(rows) : rows;
  const rawFingerprint = data?.previewFingerprint || {};

  const previewContractId = safeString(
    data?.previewContractId || rawFingerprint.previewId,
    "",
  ) || null;

  const page = safeNumber(pagination.page, 1);
  const limit = safeNumber(pagination.limit, 20);
  const total = safeNumber(pagination.total, rows.length);
  const totalPages = safeNumber(
    pagination.totalPages,
    Math.max(1, Math.ceil(total / Math.max(limit, 1))),
  );

  const matchingProductCount = safeNumber(
    data?.matchingProductCount ?? data?.productCount ?? data?.targetCount,
    total,
  );
  const affectedVariantCount = safeNumber(data?.variantCount, 0);

  return {
    success: true,
    data: {
      previewContractId,
      shop: safeString(result?.shop || data?.shop, "") || null,
      previewCounts: {
        targetCount: total,
        productCount: matchingProductCount,
        variantCount: affectedVariantCount,
      },
      sampleRows: rows,
      page,
      limit,
      total,
      totalPages,
      field: safeString(data?.canonicalField || data?.field, "") || null,
      operation: safeString(data?.operation, "") || null,
      matchingProductCount,
      affectedVariantCount,
      rows: responseRows,
      isVariant,
      requiresConfirmation: data?.requiresConfirmation === true,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        previewContractId,
      },
    },
    field: safeString(data?.canonicalField || data?.field, "") || null,
    operation: safeString(data?.operation, "") || null,
    matchingProductCount,
    affectedVariantCount,
    page,
    limit,
    total,
    totalPages,
    rows: responseRows,
  };
}

export function toBulkEditExecuteResponseDto(result) {
  const historyId = safeString(
    result?.historyId || result?.jobId || result?.id || result?.operationId,
    "",
  ) || null;
  const status = safeString(result?.status || result?.executionState, "QUEUED");

  return {
    success: true,
    data: {
      operationId: historyId,
      status,
      historyUrl: historyId ? `/editDetails/${encodeURIComponent(historyId)}` : null,
    },
  };
}

export function toScheduledEditResponseDto(result) {
  return {
    success: true,
    data: {
      scheduleId: safeString(result?.scheduleId || result?.id, "") || null,
      previewContractId: safeString(result?.previewContractId || result?.previewId, "") || null,
      status: safeString(result?.status, "SCHEDULED"),
      scheduledAt: result?.scheduledAt ? new Date(result.scheduledAt).toISOString() : null,
      timezone: safeString(result?.timezone, "UTC"),
    },
  };
}

export function toUndoEditResponseDto(result, command) {
  const undoOperationId = safeString(result?.undoOperationId || result?.id, "") || null;
  const originalOperationId = safeString(command?.operationId || result?.originalOperationId, "") || null;
  return {
    success: true,
    data: {
      undoOperationId,
      originalOperationId,
      status: safeString(result?.status, "QUEUED"),
    },
  };
}

export function toOperationCancellationResponseDto(result) {
  return {
    success: true,
    data: {
      operationId: safeString(result?.id || result?.operationId, "") || null,
      cancellationStatus: safeString(result?.cancellation || result?.status, "CANCELLED"),
      stage: safeString(result?.stage, "COMPLETED"),
    },
  };
}

export function toOperationPauseResponseDto(result) {
  return {
    success: true,
    data: {
      operationId: safeString(result?.id || result?.operationId, "") || null,
      paused: result?.paused === true,
      mode: safeString(result?.mode, "PAUSED"),
    },
  };
}

export function toOperationResumeResponseDto(result) {
  return {
    success: true,
    data: {
      operationId: safeString(result?.id || result?.operationId, "") || null,
      resumed: result?.resumed === true,
    },
  };
}

export function toOperationRetryResponseDto(result) {
  return {
    success: true,
    data: {
      retryOperationId: safeString(result?.retryOperationId || result?.id, "") || null,
      status: safeString(result?.status, "QUEUED"),
    },
  };
}

export function toPreviewVariantDetailsResponseDto(result) {
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const page = safeNumber(result?.page, 1);
  const limit = safeNumber(result?.limit, 50);
  const total = safeNumber(result?.total, rows.length);
  const totalPages = safeNumber(
    result?.totalPages,
    Math.max(1, Math.ceil(total / Math.max(limit, 1))),
  );

  return {
    success: true,
    data: {
      previewContractId: safeString(result?.previewContractId || result?.previewId, "") || null,
      productId: safeString(result?.productId, "") || null,
      page,
      limit,
      total,
      totalPages,
      rows: mapVariantSample(rows),
      isVariant: result?.isVariant === true,
    },
  };
}
