function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function assertSnapshotItemsFullyIngested(rows = [], context = "unknown") {
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    const hasPlannedMutation = isObject(row?.plannedMutation) && Object.keys(row.plannedMutation).length > 0;
    const hasBeforeValues = isObject(row?.beforeValues) && Object.keys(row.beforeValues).length > 0;

    if (!hasPlannedMutation || !hasBeforeValues) {
      const targetKey = String(row?.targetKey || row?.targetIdentity || row?.id || "unknown");
      const error = new Error("TargetSnapshotItem not fully ingested — refusing to proceed");
      error.code = "TARGET_SNAPSHOT_ITEM_NOT_FULLY_INGESTED";
      error.details = {
        context,
        targetKey,
        hasPlannedMutation,
        hasBeforeValues,
      };
      throw error;
    }
  }
}

