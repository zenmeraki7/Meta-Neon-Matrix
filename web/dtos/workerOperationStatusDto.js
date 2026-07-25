const ALLOWED_REASONS = new Set([
  "WRITE_CATALOG_LOCK_BUSY",
  "BULK_EDIT_EXECUTE_LEASE_BUSY",
  "NO_MORE_FROZEN_TARGETS",
  "cancelled_during_execution",
  "paused_during_execution",
  "shop_work_conflict",
  "shopify_bulk_busy",
  "undo_already_processing",
  "run_not_found",
  "run_already_completed",
  "run_not_actionable",
]);

export function toWorkerOperationStatusDto(result = {}) {
  const reasonRaw = String(result?.reason || "").trim();
  return {
    success: Boolean(result?.success),
    submitted: Boolean(result?.submitted),
    completed: Boolean(result?.completed),
    skipped: Boolean(result?.skipped),
    requeued: Boolean(result?.requeued),
    deferred: Boolean(result?.deferred),
    waitingForShopifySlot: Boolean(result?.waitingForShopifySlot),
    delayMs: Number.isFinite(Number(result?.delayMs)) ? Number(result.delayMs) : null,
    reason: reasonRaw && ALLOWED_REASONS.has(reasonRaw) ? reasonRaw : (reasonRaw || null),
    entityId: result?.historyId || result?.runId || result?.exportJobId || null,
    shopifyBulkOperationId: result?.shopifyBulkOperationId || null,
  };
}

