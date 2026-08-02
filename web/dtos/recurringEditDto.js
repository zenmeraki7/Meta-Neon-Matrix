function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function safeString(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

export function toRecurringEditCreatedDto(result) {
  return {
    ok: true,
    success: true,
    recurringEdit: {
      id: safeString(result?.id),
      title: safeString(result?.title),
      timezone: safeString(result?.timezone),
      nextRunAt: toIso(result?.nextRunAt),
    },
    data: result || null,
    meta: { createdAt: toIso(result?.createdAt) },
  };
}

export function toRecurringEditListDto(result) {
  return {
    success: true,
    data: Array.isArray(result?.items) ? result.items : [],
    meta: {
      pageInfo: result?.pageInfo || null,
      totalCount: Number(result?.totalCount || 0),
    },
  };
}

export function toRecurringEditDetailDto(result) {
  return {
    success: true,
    data: result || null,
  };
}

export function toRecurringEditDto(record) {
  if (!record) return null;
  return {
    id: String(record.id),
    title: String(record.title || ""),
    frequency: record.frequency,
    status: record.status,
    timeToRun: record.timeToRun ?? null,
    timezone: record.timezone,
    dayOfMonthToRun: record.dayOfMonthToRun ?? null,
    daysOfWeekToRun: Array.isArray(record.daysOfWeekToRun) ? record.daysOfWeekToRun : [],

    totalRuns: Number(record.totalRuns || 0),
    totalRunsSucceed: Number(record.totalRunsSucceed || 0),
    totalFails: Number(record.totalFails || 0),
    totalRunsSkipped: Number(record.totalRunsSkipped || 0),
    totalItems: Number(record.totalItems || 0),

    shop: record.shop,
    isCurrentlyRunning: Boolean(record.isCurrentlyRunning),

    lastRunAt: record.lastRunAt ? new Date(record.lastRunAt).toISOString() : null,
    lastRunStatus: record.lastRunStatus ?? null,
    lastRunMessage: record.lastRunMessage ?? null,
    durationMs: record.durationMs ?? null,
    createdAt: record.createdAt ? new Date(record.createdAt).toISOString() : new Date().toISOString(),
    updatedAt: record.updatedAt ? new Date(record.updatedAt).toISOString() : new Date().toISOString(),
  };
}

export function toRecurringEditUpdatedDto(result) {
  return {
    success: true,
    recurringEdit: toRecurringEditDto(result),
  };
}

export function toRecurringEditStatusUpdatedDto(result) {
  return {
    success: true,
    data: result || null,
    meta: { status: safeString(result?.status, null) },
  };
}

export function toRecurringEditDeletedDto(result) {
  return {
    success: true,
    data: {
      id: safeString(result?.id),
      deleted: Boolean(result?.deleted),
    },
  };
}
