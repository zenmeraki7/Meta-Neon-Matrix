export const SHOPIFY_BULK_MUTATION_SLOT = "SHOPIFY_BULK_MUTATION_SLOT";
export const SHOPIFY_BULK_MUTATION_SLOT_TTL_MS = 48 * 60 * 60 * 1000;

export function shopifyBulkMutationSlotResourceId(shop) {
  return String(shop || "").trim();
}

export async function acquireShopifyBulkMutationSlot({
  shop,
  ownerId,
  acquireLease = null,
}) {
  const leaseFn = acquireLease
    || (await import("./operationLeaseService.js")).acquireOperationLease;
  return leaseFn({
    shop,
    namespace: SHOPIFY_BULK_MUTATION_SLOT,
    resourceId: shopifyBulkMutationSlotResourceId(shop),
    ownerId,
    ttlMs: SHOPIFY_BULK_MUTATION_SLOT_TTL_MS,
  });
}

export async function releaseShopifyBulkMutationSlot(shop, client = null) {
  const resourceId = shopifyBulkMutationSlotResourceId(shop);
  if (!resourceId) return { count: 0 };
  const resolvedClient = client
    || (await import("../repositories/repositoryDb.js")).db;
  return resolvedClient.operationLease.updateMany({
    where: {
      shop: resourceId,
      namespace: SHOPIFY_BULK_MUTATION_SLOT,
      resourceId,
      releasedAt: null,
    },
    data: {
      releasedAt: new Date(),
      expiresAt: new Date(),
    },
  });
}
