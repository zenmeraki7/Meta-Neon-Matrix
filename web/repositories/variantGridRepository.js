import { db } from "./repositoryDb.js";
import { hasStaleVariantSync } from "../db/variantMetafields.js";
import { requireShopScope } from "../utils/shopScope.js";

export async function fetchVariantGridRows(shop, query) {
  const scopedShop = requireShopScope(shop);
  const productIds = Array.isArray(query?.productIds) ? query.productIds : [];
  const requestedGids = productIds.map((id) => id.gid).filter(Boolean);
  const productIdCandidates = [
    ...new Set(
      productIds.flatMap((id) => [id.gid, id.numericId]).filter(Boolean),
    ),
  ];
  const limit = Math.max(1, Math.min(500, Number(query?.limit) || 50));

  const store = await db.store.findUnique({
    where: { shopUrl: scopedShop },
    select: { activeMirrorBatchId: true },
  });

  const where = {
    shop: scopedShop,
    productId: { in: productIdCandidates },
    ...(store?.activeMirrorBatchId
      ? { mirrorBatchId: store.activeMirrorBatchId }
      : {}),
  };

  const [rows, isStale] = await Promise.all([
    productIdCandidates.length
      ? db.variant.findMany({
          where,
          select: {
            id: true,
            productId: true,
            title: true,
            sku: true,
            price: true,
            compareAtPrice: true,
            inventoryQuantity: true,
            position: true,
            mirrorBatchId: true,
          },
          orderBy: [
            { productId: "asc" },
            { position: "asc" },
            { id: "asc" },
          ],
          take: limit,
        })
      : Promise.resolve([]),
    hasStaleVariantSync(scopedShop, 30).catch(() => false),
  ]);

  return {
    variants: {
      rows,
      requestedProductIds: requestedGids,
      nextCursor: null,
    },
    isStale,
  };
}
