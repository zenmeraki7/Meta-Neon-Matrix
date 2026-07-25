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
    snapshotItemId: safeString(variant?.snapshotItemId, "") || undefined,
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
      snapshotItemId: safeString(row?.snapshotItemId, "") || undefined,
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
  const previewFingerprint = {
    previewId: safeString(rawFingerprint.previewId, "") || null,
    normalizedFilterHash: safeString(rawFingerprint.normalizedFilterHash, "") || null,
    mirrorBatchId: safeString(rawFingerprint.mirrorBatchId, "") || null,
    targetCount: safeNumber(rawFingerprint.targetCount, 0),
    compilerVersion: safeString(rawFingerprint.compilerVersion, "") || null,
    fieldRegistryVersion:
      safeString(rawFingerprint?.registryVersion?.fieldRegistryVersion, "") ||
      null,
    operatorRegistryVersion:
      safeString(rawFingerprint?.registryVersion?.operatorRegistryVersion, "") ||
      null,
  };
  const page = safeNumber(pagination.page, 1);
  const limit = safeNumber(pagination.limit, 20);
  const total = safeNumber(pagination.total, rows.length);
  const totalPages = safeNumber(
    pagination.totalPages,
    Math.max(1, Math.ceil(total / Math.max(limit, 1))),
  );
  const compilerVersion = safeString(rawFingerprint.compilerVersion, "") || null;
  const projectionVersion = safeString(rawFingerprint.projectionVersion, "") || null;
  const mirrorBatchId = previewFingerprint.mirrorBatchId;
  const targetDefinitionHash = previewFingerprint.normalizedFilterHash;
  const previewContractId = previewFingerprint.previewId;
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
      mirrorBatchId,
      targetDefinitionHash,
      previewCounts: {
        targetCount: total,
        productCount: matchingProductCount,
        variantCount: affectedVariantCount,
      },
      sampleRows: rows,
      compilerVersion,
      projectionVersion,
      previewId: safeString(data?.previewFingerprint?.previewId, "") || null,
      targetSnapshotId: safeString(data?.previewFingerprint?.normalizedFilterHash, "") || null,
      page,
      limit,
      total,
      totalPages,
      field: safeString(data?.canonicalField || data?.field, "") || null,
      operation: safeString(data?.operation, "") || null,
      value: data?.value ?? null,
      matchingProductCount,
      affectedVariantCount,
      rows,
      isVariant,
      previewSignature: safeString(data?.previewSignature, "") || null,
      previewFingerprint,
      requiresConfirmation: data?.requiresConfirmation === true,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        previewId: previewFingerprint.previewId,
        targetSnapshotId: previewFingerprint.normalizedFilterHash,
      },
    },
    field: safeString(data?.canonicalField || data?.field, "") || null,
    operation: safeString(data?.operation, "") || null,
    value: data?.value ?? null,
    matchingProductCount,
    affectedVariantCount,
    page,
    limit,
    total,
    totalPages,
    rounding: safeString(data?.rounding, "NONE"),
    fingerprint: previewFingerprint.normalizedFilterHash,
    previewFingerprint,
    rows: responseRows,
  };
}

export function toBulkEditExecuteResponseDto(result) {
  const historyId = safeString(
    result?.historyId || result?.jobId || result?.id || result?.operationId,
    "",
  ) || null;
  return {
    success: true,
    ...(historyId ? {
      id: historyId,
      operationId: historyId,
      historyId,
      jobId: historyId,
      historyUrl: `/editDetails/${encodeURIComponent(historyId)}`,
    } : {}),
    status: safeString(result?.status, "") || null,
    data: result || {},
  };
}

export function toScheduledEditResponseDto(result) {
  return {
    success: true,
    data: result || {},
  };
}

export function toUndoEditResponseDto(result, command) {
  return {
    success: true,
    data: result || {},
    meta: {
      operationId: command?.operationId || null,
    },
  };
}

export function toOperationCancellationResponseDto(result) {
  return { success: true, data: result || {} };
}

export function toOperationPauseResponseDto(result) {
  return { success: true, data: result || {} };
}

export function toOperationResumeResponseDto(result) {
  return { success: true, data: result || {} };
}

export function toOperationRetryResponseDto(result) {
  return { success: true, data: result || {} };
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
      previewId: safeString(result?.previewId, "") || null,
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
