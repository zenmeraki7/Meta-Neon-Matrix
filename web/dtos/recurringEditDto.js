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

export function toRecurringEditUpdatedDto(result) {
  return {
    success: true,
    data: result || null,
    meta: { updatedAt: toIso(result?.updatedAt) },
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
