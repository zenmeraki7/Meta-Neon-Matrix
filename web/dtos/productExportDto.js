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
  return {
    success: true,
    data: {
      exportJobId: result?.id || null,
      status: "QUEUED",
      queuedAt: toIso(result?.createdAt),
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
    downloadUrl: toSafeText(result?.fileUrl || result?.downloadUrl, 2000),
  };
}
