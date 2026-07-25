export async function handleProductEditOperation({ shopifyBulkOperationId, shop = null } = {}) {
  return {
    success: false,
    retired: true,
    reason: "LEGACY_BULK_FINALIZER_RETIRED",
    shopifyBulkOperationId: shopifyBulkOperationId || null,
    shop: shop || null,
  };
}

export async function fetchBulkOperationData() {
  return [];
}

export async function processNextEdit() {
  return null;
}
