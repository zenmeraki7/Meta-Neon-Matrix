export function toStoreAccessDto(result = {}) {
  return {
    message: "fetched store access successfully",
    shopUrl: result.shopUrl ?? null,
    shopTimezone: result.shopTimezone ?? "UTC",
    totalbulkEditCount: Number(result.totalbulkEditCount || 0),
    totalSyncCount: Number(result.totalSyncCount || 0),
    isProductInitialySyning: Boolean(result.isProductInitialySyning),
    isCreditAvailable: Boolean(result.isCreditAvailable),
  };
}

