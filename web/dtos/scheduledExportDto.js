function toOneScheduledExportDto(item = {}) {
  if (!item || typeof item !== "object") return null;

  if (item.deleted === true) {
    return {
      id: item.id ?? null,
      deleted: true,
    };
  }

  return {
    _id: item._id ?? item.id ?? null,
    id: item.id ?? item._id ?? null,
    shop: item.shop ?? null,
    title: item.title ?? null,
    status: item.status ?? null,
    statusKey: item.statusKey ?? null,
    frequency: item.frequency ?? null,
    scheduleType: item.scheduleType ?? null,
    timezone: item.timezone ?? null,
    scheduleConfig: item.scheduleConfig ?? null,
    cronExpression: item.cronExpression ?? null,
    intervalMinutes: item.intervalMinutes ?? null,
    fields: Array.isArray(item.fields) ? item.fields : [],
    filename: item.filename ?? null,
    filterParams: Array.isArray(item.filterParams) ? item.filterParams : [],
    filterAst: item.filterAst ?? null,
    normalizedFilterAst: item.normalizedFilterAst ?? null,
    targetingSnapshotMeta: item.targetingSnapshotMeta ?? null,
    totalRuns: Number(item.totalRuns || 0),
    successfulRuns: Number(item.successfulRuns || 0),
    totalRunsSucceed: Number(item.totalRunsSucceed || 0),
    totalRunsSkipped: Number(item.totalRunsSkipped || 0),
    totalFails: Number(item.totalFails || 0),
    runCount: Number(item.runCount || 0),
    nextRun: item.nextRun ?? null,
    nextRunAt: item.nextRunAt ?? null,
    lastRunAt: item.lastRunAt ?? null,
    lastSuccessAt: item.lastSuccessAt ?? null,
    lastFailureAt: item.lastFailureAt ?? null,
    lastFailureReason: item.lastFailureReason ?? null,
    lastRunStatus: item.lastRunStatus ?? null,
    lastRunMessage: item.lastRunMessage ?? null,
    lastFileUrl: item.lastFileUrl ?? null,
    startAt: item.startAt ?? null,
    endAt: item.endAt ?? null,
    createdAt: item.createdAt ?? null,
    updatedAt: item.updatedAt ?? null,
  };
}

export function toScheduledExportDto(data) {
  if (Array.isArray(data)) {
    return data.map(toOneScheduledExportDto);
  }

  return toOneScheduledExportDto(data);
}

