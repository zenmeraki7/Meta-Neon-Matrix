function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toSafeText(value, max = 2000) {
  if (typeof value !== "string") return null;
  const v = value.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  return v ? v.slice(0, max) : null;
}

export function toExportJobQueuedResponseDto(result) {
  const exportJobId = result?.id || null;
  const queuedAt = toIso(result?.createdAt);
  return {
    success: true,
    exportJobId,
    status: "QUEUED",
    queuedAt,
    data: {
      exportJobId,
      status: "QUEUED",
      queuedAt,
    },
  };
}

export function toExportCancellationResponseDto(result) {
  return {
    success: true,
    data: {
      id: result?.id || null,
      stage: toSafeText(result?.stage, 100),
      cancellation: toSafeText(result?.cancellation, 120),
    },
  };
}

export function toExportPauseResponseDto(result) {
  return {
    success: true,
    data: {
      id: result?.id || null,
      paused: Boolean(result?.paused),
      mode: toSafeText(result?.mode, 120),
    },
  };
}

export function toExportResumeResponseDto(result) {
  return {
    success: true,
    data: {
      id: result?.id || null,
      resumed: Boolean(result?.resumed),
    },
  };
}

export function toExportDownloadRedirectDto(result) {
  return {
    downloadUrl: toSafeText(result?.downloadUrl || result?.downloadUrl, 2000),
  };
}

const DOWNLOAD_ERROR_CONFIG = Object.freeze({
  VALIDATION_FAILED: {
    statusCode: 400,
    message: "Invalid export id.",
  },
  UNAUTHENTICATED: {
    statusCode: 401,
    message: "Authentication required.",
  },
  EXPORT_NOT_FOUND: {
    statusCode: 404,
    message: "This export is no longer available.",
  },
  EXPORT_NOT_READY: {
    statusCode: 409,
    message: "The export file is not available yet.",
  },
  EXPORT_FILE_REFERENCE_MISSING: {
    statusCode: 409,
    message: "The export file is not available yet.",
  },
  EXPORT_FILE_REFERENCE_INVALID: {
    statusCode: 500,
    message: "The export file could not be retrieved. Please try again.",
  },
  EXPORT_FILE_REFERENCE_UNSAFE: {
    statusCode: 500,
    message: "The export file could not be retrieved. Please try again.",
  },
  EXPORT_FILE_BODY_MISSING: {
    statusCode: 502,
    message: "The export file could not be retrieved. Please try again.",
  },
  EXPORT_FILE_UPSTREAM_UNAVAILABLE: {
    statusCode: 503,
    message: "The export file could not be retrieved. Please try again.",
  },
  EXPORT_FILE_TIMEOUT: {
    statusCode: 504,
    message: "The export file retrieval timed out. Please try again.",
  },
});

export function toExportDownloadErrorDto(error) {
  const configured = DOWNLOAD_ERROR_CONFIG[error?.code];

  const code = configured ? error.code : "EXPORT_DOWNLOAD_FAILED";

  return Object.freeze({
    statusCode: configured?.statusCode ?? 500,
    body: Object.freeze({
      success: false,
      code,
      message:
        configured?.message ??
        "The export file could not be retrieved. Please try again.",
    }),
  });
}

export function toProductExportFieldListDto(result) {
  const fields = Array.isArray(result?.fields)
    ? result.fields.map((field) => ({
        key: field.key,
        label: field.label,
        dataType: field.dataType,
        targetGranularity: field.targetGranularity,
        available: field.available !== false,
      }))
    : [];

  return Object.freeze({
    success: true,
    fields,
  });
}
