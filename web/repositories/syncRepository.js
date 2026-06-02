import { prisma } from "../config/database.js";
import { requireShopScope } from "../utils/shopScope.js";

export async function getProductCountByShop(shop) {
  const resolvedShop = requireShopScope(shop);
  const productCount = await prisma.product.count({ where: { shop: resolvedShop } });
  return Number(productCount || 0);
}

export async function getLatestCompletedProductSyncByShop(shop) {
  const resolvedShop = requireShopScope(shop);

  return prisma.syncHistory.findFirst({
    where: {
      shop: resolvedShop,
      operationType: "Product",
      status: "completed",
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      updatedAt: true,
      recordCount: true,
      syncBatchId: true,
    },
  });
}

export async function countCompletedBulkEditsByShop(shop) {
  const resolvedShop = requireShopScope(shop);
  return prisma.editHistory.count({
    where: {
      shop: resolvedShop,
      status: { in: ["completed", "Undo completed"] },
    },
  });
}

export async function countCompletedProductSyncsByShop(shop) {
  const resolvedShop = requireShopScope(shop);
  return prisma.syncHistory.count({
    where: { shop: resolvedShop, status: "completed" },
  });
}

export async function getLatestProductSyncByShop(shop) {
  const resolvedShop = requireShopScope(shop);
  return prisma.syncHistory.findFirst({
    where: { shop: resolvedShop, operationType: "Product" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      bulkOperationId: true,
      syncBatchId: true,
      status: true,
      stage: true,
      recordCount: true,
      updatedAt: true,
      errorMessage: true,
      isInitialProductSync: true,
    },
  });
}

export async function getLatestProductSyncSummaryByShop(shop) {
  const resolvedShop = requireShopScope(shop);
  return prisma.syncHistory.findFirst({
    where: { shop: resolvedShop, operationType: "Product" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      stage: true,
      updatedAt: true,
      errorMessage: true,
      isInitialProductSync: true,
    },
  });
}
