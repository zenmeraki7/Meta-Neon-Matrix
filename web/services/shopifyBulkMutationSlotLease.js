export const SHOPIFY_BULK_MUTATION_SLOT = "SHOPIFY_BULK_MUTATION_SLOT";
export const SHOPIFY_BULK_MUTATION_SLOT_TTL_MS = 30 * 60 * 1000;

export function shopifyBulkMutationSlotResourceId(shop) {
  return String(shop || "").trim();
}
