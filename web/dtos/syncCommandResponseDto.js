export function toSyncCommandResponseDto(result = {}) {
  const skipped = Boolean(result?.skipped);
  return {
    success: skipped ? true : Boolean(result?.success),
    skipped,
    forced: Boolean(result?.forced),
    forceAllowed: Boolean(result?.forceAllowed),
    message: String(result?.message || "").trim() || (skipped ? "Skipped" : "Started"),
    data: result?.data && typeof result.data === "object" ? result.data : null,
    shopifyBulkOperationId: result?.shopifyBulkOperationId || null,
    syncHistoryId: result?.syncHistoryId || null,
    mirrorBatchId: result?.mirrorBatchId || null,
  };
}

