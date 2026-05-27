import { prisma } from "../../config/database.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
import {
  createMirrorBatchId,
  markFullSyncStarted,
} from "../mirrorHealthService.js";

async function transitionMirrorSyncLedgerBySyncHistoryId(tx, {
  shop,
  syncHistoryId,
  from,
  to,
  data = {},
}) {
  if (!shop || !syncHistoryId) return 0;
  const updated = await tx.operationFingerprint.updateMany({
    where: {
      shop,
      operationType: "MIRROR_SYNC",
      resourceType: "sync_history",
      resourceId: String(syncHistoryId),
      status: Array.isArray(from) ? { in: from } : from,
    },
    data: {
      status: to,
      ...data,
      updatedAt: new Date(),
    },
  });
  return Number(updated?.count || 0);
}

async function upsertMirrorBatch(tx, {
  id,
  shop,
  syncHistoryId = null,
  bulkOperationId = null,
  resourceType = "PRODUCT_CATALOG",
  status = "SYNC_REQUESTED",
}) {
  return tx.mirrorBatch.upsert({
    where: { id },
    update: {
      shop,
      syncHistoryId,
      bulkOperationId,
      resourceType,
      status,
      failureReason: null,
      failedAt: null,
    },
    create: {
      id,
      shop,
      syncHistoryId,
      bulkOperationId,
      resourceType,
      status,
    },
  });
}

export async function markMirrorBatchStatus({
  shop,
  syncBatchId,
  status,
  failureReason = null,
  counts = {},
}) {
  if (!syncBatchId) return;

  const data = {
    status,
    ...(failureReason ? { failureReason } : {}),
    ...(status === "FAILED" ? { failedAt: new Date() } : {}),
    ...(status === "ACTIVE" ? { activatedAt: new Date() } : {}),
    ...(typeof counts.actualProducts === "number" ? { actualProducts: counts.actualProducts } : {}),
    ...(typeof counts.actualVariants === "number" ? { actualVariants: counts.actualVariants } : {}),
    ...(typeof counts.actualCollections === "number" ? { actualCollections: counts.actualCollections } : {}),
    ...(typeof counts.actualMetafields === "number" ? { actualMetafields: counts.actualMetafields } : {}),
  };

  await prisma.mirrorBatch.updateMany({
    where: { id: syncBatchId, shop },
    data,
  });
}

export async function markProductSyncStarted({ shop }) {
  await markFullSyncStarted(shop);
}

export async function queueProductSyncStart({
  shop,
  bulkOperationId,
  isInitialSync = false,
}) {
  const syncBatchId = createMirrorBatchId("product_sync");

  const syncHistory = await prisma.$transaction(async (tx) => {
    await tx.store.update({
      where: { shopUrl: shop },
      data: {
        isProductSyncing: true,
        isProductInitialySyning: isInitialSync,
        shopifyBulkJobCompleted: false,
        syncProgressStage: "SHOPIFY_BULK_RUNNING",
        staleReason: "FULL_SYNC_RUNNING",
        lastSyncErrorSummary: null,
        mirrorUnsafeSince: new Date(),
      },
    });

    const createdHistory = await tx.syncHistory.create({
      data: {
        shop,
        bulkOperationId,
        syncBatchId,
        status: "processing",
        stage: "SHOPIFY_BULK_RUNNING",
        operationType: "Product",
        isInitialProductSync: isInitialSync,
        recordCount: 0,
        duration: 0,
      },
    });

    await upsertMirrorBatch(tx, {
      id: syncBatchId,
      shop,
      syncHistoryId: createdHistory.id,
      bulkOperationId,
      resourceType: "PRODUCT_CATALOG",
      status: "BULK_OPERATION_STARTED",
    });

    return createdHistory;
  });

  return syncHistory;
}

export async function clearProductSyncCache(shop) {
  await clearKeyCaches(`${shop}:sync_details`);
}

export async function stageProductMirrorBatch({
  shop,
  syncBatchId,
  syncHistoryId = null,
}) {
  await prisma.$transaction(async (tx) => {
    await tx.store.update({
      where: { shopUrl: shop },
      data: {
        syncProgressStage: "MIRROR_STAGING",
        staleReason: "FULL_SYNC_RUNNING",
      },
    });

    if (syncHistoryId) {
      await tx.syncHistory.update({
        where: { id: syncHistoryId },
        data: {
          stage: "MIRROR_STAGING",
        },
      });
    }

    await upsertMirrorBatch(tx, {
      id: syncBatchId,
      shop,
      syncHistoryId,
      resourceType: "PRODUCT_CATALOG",
      status: "INGESTING_TO_STAGING_BATCH",
    });
    await transitionMirrorSyncLedgerBySyncHistoryId(tx, {
      shop,
      syncHistoryId,
      from: ["RUNNING", "STARTING_BULK_QUERY"],
      to: "INGESTING",
    });

    await tx.variant.deleteMany({
      where: {
        shop,
        mirrorBatchId: syncBatchId,
      },
    });
    await tx.inventoryLevelMirror.deleteMany({
      where: {
        shop,
        mirrorBatchId: syncBatchId,
      },
    });
    await tx.inventoryItemMirror.deleteMany({
      where: {
        shop,
        mirrorBatchId: syncBatchId,
      },
    });
    await tx.productCollection.deleteMany({
      where: {
        shop,
        mirrorBatchId: syncBatchId,
      },
    });
    await tx.metafieldMirror.deleteMany({
      where: {
        shop,
        mirrorBatchId: syncBatchId,
      },
    });

    await tx.product.deleteMany({
      where: {
        shop,
        mirrorBatchId: syncBatchId,
      },
    });
  });
}

export async function insertProductMirrorBatch({
  productRows,
  variantRows,
  inventoryItemRows,
  inventoryLevelRows,
  productCollectionRows,
  metafieldRows,
  syncBatchId,
}) {
  if (productRows.length > 0) {
    await prisma.product.createMany({
      data: productRows.map((row) => ({ ...row, mirrorBatchId: syncBatchId })),
      skipDuplicates: true,
    });
  }

  if (variantRows.length > 0) {
    await prisma.variant.createMany({
      data: variantRows.map((row) => ({ ...row, mirrorBatchId: syncBatchId })),
      skipDuplicates: true,
    });
  }

  if (Array.isArray(inventoryItemRows) && inventoryItemRows.length > 0) {
    await prisma.inventoryItemMirror.createMany({
      data: inventoryItemRows.map((row) => ({ ...row, mirrorBatchId: syncBatchId })),
      skipDuplicates: true,
    });
  }

  if (Array.isArray(inventoryLevelRows) && inventoryLevelRows.length > 0) {
    await prisma.inventoryLevelMirror.createMany({
      data: inventoryLevelRows.map((row) => ({ ...row, mirrorBatchId: syncBatchId })),
      skipDuplicates: true,
    });
  }

  if (Array.isArray(productCollectionRows) && productCollectionRows.length > 0) {
    await prisma.productCollection.createMany({
      data: productCollectionRows.map((row) => ({ ...row, mirrorBatchId: syncBatchId })),
      skipDuplicates: true,
    });
  }

  if (Array.isArray(metafieldRows) && metafieldRows.length > 0) {
    await prisma.metafieldMirror.createMany({
      data: metafieldRows.map((row) => ({ ...row, mirrorBatchId: syncBatchId })),
      skipDuplicates: true,
    });
  }
}

export async function markSyncHistoryFailed({
  shop,
  syncHistoryId,
  errorMessage,
}) {
  await prisma.$transaction(async (tx) => {
    if (syncHistoryId) {
      const syncHistory = await tx.syncHistory.findUnique({
        where: { id: syncHistoryId },
      });
      if (!syncHistory) {
        throw new Error("SYNC_HISTORY_NOT_FOUND");
      }
      const updatedSyncHistoryResult = await tx.syncHistory.updateMany({
        where: {
          id: syncHistoryId,
          shop: syncHistory.shop,
          status: { in: ["processing", "queued"] },
          stage: {
            in: [
              "SHOPIFY_BULK_RUNNING",
              "MIRROR_STAGING",
              "INGESTING_TO_STAGING_BATCH",
              "VALIDATING_BATCH",
              "ACTIVATING_BATCH",
              "ACTIVE",
            ],
          },
        },
        data: {
          status: "failed",
          stage: "FAILED",
          errorMessage,
        },
      });
      if (updatedSyncHistoryResult.count !== 1) {
        return;
      }

      if (syncHistory.syncBatchId) {
        await upsertMirrorBatch(tx, {
          id: syncHistory.syncBatchId,
          shop: syncHistory.shop,
          syncHistoryId: syncHistory.id,
          bulkOperationId: syncHistory.bulkOperationId || null,
          resourceType: "PRODUCT_CATALOG",
          status: "FAILED",
        });
        await tx.mirrorBatch.updateMany({
          where: {
            id: syncHistory.syncBatchId,
            shop: syncHistory.shop,
            status: {
              in: [
                "SYNC_REQUESTED",
                "BULK_OPERATION_STARTED",
                "FILE_DOWNLOADED",
                "INGESTING_TO_STAGING_BATCH",
                "VALIDATING_BATCH",
                "ACTIVATING_BATCH",
              ],
            },
          },
          data: {
            status: "FAILED",
            failedAt: new Date(),
            failureReason: errorMessage,
          },
        });
      }

      await transitionMirrorSyncLedgerBySyncHistoryId(tx, {
        shop: syncHistory.shop,
        syncHistoryId: syncHistory.id,
        from: ["QUEUED", "STARTING_BULK_QUERY", "RUNNING", "INGESTING"],
        to: "FAILED",
        data: { lastError: errorMessage || null },
      });
    }

    if (shop) {
      await tx.store.update({
        where: { shopUrl: shop },
        data: {
          isProductSyncing: false,
          isProductInitialySyning: false,
          syncProgressStage: "IDLE",
          mirrorHealthState: "UNSAFE",
          staleReason: "FULL_SYNC_FAILED",
          repairRequired: true,
          mirrorUnsafeSince: new Date(),
          lastSyncErrorSummary: errorMessage,
        },
      });
    }
  });
}

export async function activateProductMirrorBatch({
  shop,
  syncBatchId,
  totalProductsProcessed,
  totalVariantsProcessed = null,
  syncHistoryId,
}) {
  const store = await prisma.store.findUnique({
    where: { shopUrl: shop },
    select: { activeMirrorBatchId: true },
  });

  const previousBatchId = store?.activeMirrorBatchId || null;
  const completedAt = new Date();

  await prisma.$transaction(async (tx) => {
    const storeActivated = await tx.store.updateMany({
      where: {
        shopUrl: shop,
        isProductSyncing: true,
      },
      data: {
        activeMirrorBatchId: syncBatchId,
        mirrorHealthState: "HEALTHY",
        staleReason: null,
        repairRequired: false,
        mirrorUnsafeSince: null,
        lastSyncErrorSummary: null,
        lastFullSyncAt: completedAt,
        isProductSyncing: false,
        isProductInitialySyning: false,
        syncProgressStage: "IDLE",
        shopifyBulkJobCompleted: true,
        storeTotalProducts: totalProductsProcessed,
        productInitialSyncProgress: totalProductsProcessed,
        lastProductSyncAt: completedAt,
      },
    });
    if (storeActivated.count !== 1) {
      throw new Error("STORE_SYNC_ACTIVATION_TRANSITION_REJECTED");
    }

    if (syncHistoryId) {
      const updatedSyncHistory = await tx.syncHistory.updateMany({
        where: {
          id: syncHistoryId,
          shop,
          status: { in: ["processing", "queued"] },
          stage: {
            in: ["MIRROR_STAGING", "INGESTING_TO_STAGING_BATCH", "VALIDATING_BATCH", "ACTIVATING_BATCH"],
          },
        },
        data: {
          status: "completed",
          stage: "MIRROR_ACTIVATED",
          recordCount: totalProductsProcessed,
          updatedAt: completedAt,
        },
      });
      if (updatedSyncHistory.count !== 1) {
        throw new Error("SYNC_HISTORY_ACTIVATION_TRANSITION_REJECTED");
      }

      await upsertMirrorBatch(tx, {
        id: syncBatchId,
        shop,
        syncHistoryId,
        bulkOperationId: null,
        resourceType: "PRODUCT_CATALOG",
        status: "ACTIVE",
      });
      await tx.mirrorBatch.updateMany({
        where: {
          id: syncBatchId,
          shop,
          status: {
            in: [
              "BULK_OPERATION_STARTED",
              "FILE_DOWNLOADED",
              "INGESTING_TO_STAGING_BATCH",
              "VALIDATING_BATCH",
              "ACTIVATING_BATCH",
              "ACTIVE",
            ],
          },
        },
        data: {
          status: "ACTIVE",
          activatedAt: completedAt,
          actualProducts: totalProductsProcessed,
          ...(typeof totalVariantsProcessed === "number"
            ? { actualVariants: totalVariantsProcessed }
            : {}),
          failureReason: null,
          failedAt: null,
        },
      });
      await transitionMirrorSyncLedgerBySyncHistoryId(tx, {
        shop,
        syncHistoryId,
        from: ["QUEUED", "STARTING_BULK_QUERY", "RUNNING", "INGESTING"],
        to: "COMPLETED",
      });
    }

    if (!syncHistoryId) {
      await tx.mirrorBatch.updateMany({
        where: {
          id: syncBatchId,
          shop,
          status: {
            in: [
              "BULK_OPERATION_STARTED",
              "FILE_DOWNLOADED",
              "INGESTING_TO_STAGING_BATCH",
              "VALIDATING_BATCH",
              "ACTIVATING_BATCH",
            ],
          },
        },
        data: {
          status: "ACTIVE",
          activatedAt: completedAt,
          actualProducts: totalProductsProcessed,
          ...(typeof totalVariantsProcessed === "number"
            ? { actualVariants: totalVariantsProcessed }
            : {}),
          failureReason: null,
          failedAt: null,
        },
      });
    }

    if (previousBatchId && previousBatchId !== syncBatchId) {
      await tx.variant.deleteMany({
        where: { shop, mirrorBatchId: previousBatchId },
      });
      await tx.inventoryLevelMirror.deleteMany({
        where: { shop, mirrorBatchId: previousBatchId },
      });
      await tx.inventoryItemMirror.deleteMany({
        where: { shop, mirrorBatchId: previousBatchId },
      });
      await tx.productCollection.deleteMany({
        where: { shop, mirrorBatchId: previousBatchId },
      });
      await tx.metafieldMirror.deleteMany({
        where: { shop, mirrorBatchId: previousBatchId },
      });
      await tx.product.deleteMany({
        where: { shop, mirrorBatchId: previousBatchId },
      });
    }
  });
}

export async function updateInitialSyncProgress({
  shop,
  totalProductsProcessed,
}) {
  await prisma.store.update({
    where: { shopUrl: shop },
    data: {
      productInitialSyncProgress: totalProductsProcessed,
      syncProgressStage: "MIRROR_STAGING",
    },
  });
}
