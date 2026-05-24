function toIsoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function toPublicAutomaticRuleRunStatus(status) {
  const key = String(status || "").toUpperCase();
  const map = {
    TARGET_FREEZE_QUEUED: "preparing",
    PENDING: "queued",
    QUEUED: "queued",
    TARGET_FREEZING: "preparing",
    TARGET_FROZEN: "ready",
    PROCESSING: "running",
    EXECUTING: "running",
    VERIFYING: "verifying",
    SUCCESS: "completed",
    SUCCEEDED: "completed",
    FAILED: "failed",
    SKIPPED: "cancelled",
    CANCELLED: "cancelled",
    UNDO_PENDING: "undo_pending",
    UNDO_EXECUTING: "undo_running",
  };
  return map[key] || "unknown";
}

export function toAutomaticRuleCreateDto(rule) {
  return {
    ruleId: rule?.id || null,
    status: rule?.statusKey || rule?.status || null,
    createdAt: toIsoOrNull(rule?.createdAt),
  };
}

export function toAutomaticRuleListDto(rules = []) {
  return Array.isArray(rules)
    ? rules.map((rule) => ({
        id: rule?.id || null,
        title: rule?.title || "",
        status: rule?.statusKey || rule?.status || null,
        enabled: String(rule?.statusKey || rule?.status || "").toUpperCase() === "ACTIVE",
        triggerType: rule?.triggerType || null,
        nextRunAt: toIsoOrNull(rule?.nextRunAt),
        lastRunAt: toIsoOrNull(rule?.lastRunAt),
        createdAt: toIsoOrNull(rule?.createdAt),
      }))
    : [];
}

export function toAutomaticRuleDetailDto(rule) {
  return {
    id: rule?.id || null,
    title: rule?.title || "",
    description: rule?.description || null,
    status: rule?.statusKey || rule?.status || null,
    enabled: String(rule?.statusKey || rule?.status || "").toUpperCase() === "ACTIVE",
    triggerType: rule?.triggerType || null,
    filterSummary: {
      conditionCount: Array.isArray(rule?.conditions) ? rule.conditions.length : 0,
    },
    editSummary: {
      ruleCount: Array.isArray(rule?.actions) ? rule.actions.length : 0,
    },
    schedule: {
      scheduleType: rule?.scheduleType || null,
      timezone: rule?.timezone || null,
      intervalMinutes: rule?.intervalMinutes ?? null,
      cronExpression: rule?.cronExpression || null,
      scheduleConfig: rule?.scheduleConfig || null,
    },
    nextRunAt: toIsoOrNull(rule?.nextRunAt),
    lastRunAt: toIsoOrNull(rule?.lastRunAt),
    createdAt: toIsoOrNull(rule?.createdAt),
    updatedAt: toIsoOrNull(rule?.updatedAt),
  };
}

export function toAutomaticRuleStateDto(rule, overrides = {}) {
  return {
    ruleId: rule?.id || overrides.ruleId || null,
    status: overrides.status || rule?.statusKey || rule?.status || null,
    pausedAt: overrides.pausedAt || null,
    resumedAt: overrides.resumedAt || null,
    nextRunAt: overrides.nextRunAt || null,
  };
}

export function toAutomaticRuleDeleteDto(result) {
  return {
    ruleId: result?.id || null,
    deleted: Boolean(result?.deleted),
    deletedAt: toIsoOrNull(result?.deletedAt || new Date()),
  };
}

export function toAutomaticRuleRunListDto(runs = []) {
  return Array.isArray(runs)
    ? runs.map((run) => ({
        id: run?.id || null,
        ruleId: run?.automaticProductRuleId || null,
        status: toPublicAutomaticRuleRunStatus(run?.status),
        targetCount: run?.matchedCount ?? null,
        successCount: run?.status === "SUCCESS" ? run?.affectedCount ?? null : null,
        failedCount: run?.status === "FAILED" ? run?.affectedCount ?? null : null,
        startedAt: toIsoOrNull(run?.startedAt),
        completedAt: toIsoOrNull(run?.completedAt),
      }))
    : [];
}

export function toAutomaticRuleRunCommandDto(run) {
  return {
    operationId: run?.executionKey || run?.id || null,
    runId: run?.id || null,
    status: "QUEUED",
  };
}

export function toAutomaticRuleUpdateDto(rule) {
  if (!rule) {
    return null;
  }

  return {
    ruleId: rule.id,
    status: rule.statusKey || rule.status,
    updatedAt: rule.updatedAt || null,
    revision: rule.revision ?? rule.ruleRevision ?? null,
    configFingerprint: rule.configFingerprint ?? null,
  };
}
