function normalizeDelay(delay) {
  if (!Number.isFinite(delay) || delay <= 0) {
    return undefined;
  }

  return Math.floor(delay);
}

export function safeJobId(value) {
  return String(value || "unknown")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 180);
}

export function joinSafeJobId(...parts) {
  return safeJobId(parts.filter(Boolean).join("__"));
}

export function buildJobBackoff(delay = 5_000) {
  return {
    type: "exponential",
    delay,
  };
}

export function buildDefaultJobOptions({
  attempts = 5,
  delay,
  priority,
  removeOnComplete = { age: 24 * 3600, count: 500 },
  removeOnFail = { age: 7 * 24 * 3600, count: 2_000 },
  backoffDelay = 5_000,
} = {}) {
  return {
    attempts,
    backoff: buildJobBackoff(backoffDelay),
    removeOnComplete,
    removeOnFail,
    ...(priority !== undefined ? { priority } : {}),
    ...(normalizeDelay(delay) ? { delay: normalizeDelay(delay) } : {}),
  };
}

export function mergeJobOptions(baseOptions = {}, overrideOptions = {}) {
  return {
    ...baseOptions,
    ...overrideOptions,
    ...(baseOptions.backoff || overrideOptions.backoff
      ? {
          backoff: {
            ...(baseOptions.backoff || {}),
            ...(overrideOptions.backoff || {}),
          },
        }
      : {}),
    ...(baseOptions.removeOnComplete || overrideOptions.removeOnComplete
      ? {
          removeOnComplete:
            overrideOptions.removeOnComplete ?? baseOptions.removeOnComplete,
        }
      : {}),
    ...(baseOptions.removeOnFail || overrideOptions.removeOnFail
      ? {
          removeOnFail: overrideOptions.removeOnFail ?? baseOptions.removeOnFail,
        }
      : {}),
  };
}

export function buildWebhookJobId({ topic, webhookId, shop, entityId }) {
  return joinSafeJobId(
    "webhook",
    topic,
    shop,
    webhookId || entityId || "unknown"
  );
}

export function buildBulkTargetFreezeJobId({ shop, operationId }) {
  return joinSafeJobId("target-freeze", shop, operationId);
}

export function buildBulkEditExecuteJobId({ shop, operationId, executionId }) {
  return joinSafeJobId("bulk-edit-execute", shop, operationId, executionId);
}

export function buildBulkOperationMutationJobId({ shop, operationId }) {
  return joinSafeJobId("bulk-operation-mutation", shop, operationId);
}

export function bulkOperationMutationJobId({
  shop,
  operationId,
  bulkOperationId,
}) {
  if (operationId && bulkOperationId) {
    return joinSafeJobId("bulk-operation-mutation", shop, operationId, bulkOperationId);
  }
  return buildBulkOperationMutationJobId({
    shop,
    operationId: operationId || bulkOperationId || "unknown",
  });
}

export function buildBulkPipelineStageJobId({ shop, operationId, stage, executionId }) {
  return joinSafeJobId(stage, shop, operationId, executionId);
}

export function buildProductSyncClearTypesJobId({ shop, operationId }) {
  return joinSafeJobId("product-sync-clear-product-types", shop, operationId);
}

export function buildAutomaticRuleRunJobId({ shop, ruleId, executionKey }) {
  return joinSafeJobId("automatic-rule-run", shop, ruleId, executionKey);
}

export function buildBulkResultIngestJobId({ shop, bulkOperationId }) {
  return joinSafeJobId("bulk-edit-result-ingest", shop, bulkOperationId);
}

export function buildUndoExecuteJobId({ shop, undoOperationId, executionId, source = "default" }) {
  return joinSafeJobId("undo-execute", shop, undoOperationId, executionId, source);
}

export function buildScheduledRuleRunJobId({ shop, ruleId, scheduledFor }) {
  return joinSafeJobId("scheduled-rule-run", shop, ruleId, normalizeScheduledFor(scheduledFor));
}

export function buildRecurringRuleRunJobId({ shop, ruleId, scheduledFor }) {
  return joinSafeJobId("recurring-rule-run", shop, ruleId, normalizeScheduledFor(scheduledFor));
}

export function normalizeScheduledFor(value) {
  const parsed = new Date(value || 0);
  if (Number.isNaN(parsed.getTime())) {
    return "unspecified";
  }
  return parsed.toISOString();
}

export function bulkEditExecuteJobId({ shop, operationId, executionId }) {
  return buildBulkEditExecuteJobId({ shop, operationId, executionId });
}

export function bulkEditResultIngestJobId({ shop, bulkOperationId }) {
  return buildBulkResultIngestJobId({ shop, bulkOperationId });
}

export function undoExecuteJobId({ shop, undoOperationId, executionId, source }) {
  return buildUndoExecuteJobId({ shop, undoOperationId, executionId, source });
}

export function scheduledEditRunJobId({ shop, scheduledEditId, scheduledFor }) {
  return joinSafeJobId(
    "scheduled-edit-run",
    shop,
    scheduledEditId,
    normalizeScheduledFor(scheduledFor),
  );
}

export function recurringRuleRunJobId({ shop, ruleId, scheduledFor }) {
  return buildRecurringRuleRunJobId({ shop, ruleId, scheduledFor });
}

export function scheduledExportRunJobId({
  shop,
  scheduledExportId,
  scheduledFor,
}) {
  return joinSafeJobId(
    "scheduled-export-run",
    shop,
    scheduledExportId,
    normalizeScheduledFor(scheduledFor),
  );
}
