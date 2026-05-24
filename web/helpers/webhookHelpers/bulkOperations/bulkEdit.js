export async function handleProductEditOperation({ bulkOperationId, shop = null } = {}) {
  return {
    success: false,
    retired: true,
    reason: "LEGACY_BULK_FINALIZER_RETIRED",
    bulkOperationId: bulkOperationId || null,
    shop: shop || null,
  };
}

export async function fetchBulkOperationData() {
  return [];
}

export async function processNextEdit() {
  return null;
}
