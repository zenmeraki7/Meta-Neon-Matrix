import { prisma } from "../config/database.js";
import { clearKeyCaches } from "../utils/cacheUtils.js";
import {
  ensureStoreForShop,
  logStoreMutation,
} from "./storeRepository.js";
import {
  createMirrorBatchId,
  markFullSyncStarted,
} from "../services/mirrorHealthService.js";

const ACTIVATION_PRESERVE_CHUNK_SIZE = 500;
const PRODUCT_SYNC_CACHE_KEYS = [":sync_details", ":sync_summary"];

function chunk(items, size = ACTIVATION_PRESERVE_CHUNK_SIZE) {
  const rows = Array.isArray(items) ? items : [];
  const chunks = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}

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
    const store = await ensureStoreForShop({ shop }, tx);
    logStoreMutation("queueProductSyncStart.store.updateMany", {
      shop,
      storeId: store.id,
      syncBatchId,
      bulkOperationId,
    });
    await tx.store.updateMany({
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
  await Promise.all(
    PRODUCT_SYNC_CACHE_KEYS.map((suffix) => clearKeyCaches(`${shop}${suffix}`)),
  );
}

export async function stageProductMirrorBatch({
  shop,
  syncBatchId,
  syncHistoryId = null,
}) {
  await prisma.$transaction(async (tx) => {
    const store = await ensureStoreForShop({ shop }, tx);
    logStoreMutation("stageProductMirrorBatch.store.updateMany", {
      shop,
      storeId: store.id,
      syncHistoryId,
      syncBatchId,
    });
    await tx.store.updateMany({
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
  }, {
    maxWait: 10_000,
    timeout: 60_000,
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
  const operations = [];

  if (productRows.length > 0) {
    operations.push(prisma.product.createMany({
      data: productRows.map((row) => ({ ...row, mirrorBatchId: syncBatchId })),
      skipDuplicates: true,
    }));
  }

  if (variantRows.length > 0) {
    operations.push(prisma.variant.createMany({
      data: variantRows.map((row) => ({ ...row, mirrorBatchId: syncBatchId })),
      skipDuplicates: true,
    }));
  }

  if (Array.isArray(inventoryItemRows) && inventoryItemRows.length > 0) {
    operations.push(prisma.inventoryItemMirror.createMany({
      data: inventoryItemRows.map((row) => ({ ...row, mirrorBatchId: syncBatchId })),
      skipDuplicates: true,
    }));
  }

  if (Array.isArray(inventoryLevelRows) && inventoryLevelRows.length > 0) {
    operations.push(prisma.inventoryLevelMirror.createMany({
      data: inventoryLevelRows.map((row) => ({ ...row, mirrorBatchId: syncBatchId })),
      skipDuplicates: true,
    }));
  }

  if (Array.isArray(productCollectionRows) && productCollectionRows.length > 0) {
    operations.push(prisma.productCollection.createMany({
      data: productCollectionRows.map((row) => ({ ...row, mirrorBatchId: syncBatchId })),
      skipDuplicates: true,
    }));
  }

  if (Array.isArray(metafieldRows) && metafieldRows.length > 0) {
    operations.push(prisma.metafieldMirror.createMany({
      data: metafieldRows.map((row) => ({ ...row, mirrorBatchId: syncBatchId })),
      skipDuplicates: true,
    }));
  }

  if (operations.length > 0) {
    await prisma.$transaction(operations);
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
        console.warn("[sync:history_missing_on_fail]", {
          shop,
          syncHistoryId,
          errorMessage,
        });
      } else {
        const updatedSyncHistoryResult = await tx.syncHistory.updateMany({
          where: {
            id: syncHistoryId,
            shop: syncHistory.shop,
            status: "processing",
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
          console.warn("[sync:history_fail_transition_skipped]", {
            shop,
            syncHistoryId,
            currentStatus: syncHistory.status,
            currentStage: syncHistory.stage,
          });
        } else if (syncHistory.syncBatchId) {
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
    }

    if (shop) {
      const store = await ensureStoreForShop({ shop }, tx);
      logStoreMutation("markSyncHistoryFailed.store.updateMany", {
        shop,
        storeId: store.id,
        syncHistoryId,
      });
      await tx.store.updateMany({
        where: { shopUrl: shop },
        data: {
          isProductSyncing: false,
          isProductInitialySyning: false,
          syncProgressStage: "IDLE",
          shopifyBulkJobCompleted: false,
          mirrorHealthState: "UNSAFE",
          staleReason: "FULL_SYNC_FAILED",
          repairRequired: true,
          mirrorUnsafeSince: new Date(),
          lastSyncErrorSummary: errorMessage,
        },
      });
    }
  });
  if (shop) {
    await clearProductSyncCache(shop);
  }
}

async function preserveNewerPreviousBatchProducts(tx, {
  shop,
  previousBatchId,
  syncBatchId,
}) {
  const candidates = await tx.$queryRaw`
    SELECT previous_product."id"
    FROM "Product" previous_product
    LEFT JOIN "Product" staged_product
      ON staged_product."shop" = previous_product."shop"
     AND staged_product."id" = previous_product."id"
     AND staged_product."mirrorBatchId" = ${syncBatchId}
    WHERE previous_product."shop" = ${shop}
      AND previous_product."mirrorBatchId" = ${previousBatchId}
      AND (
        staged_product."id" IS NULL
        OR (
          previous_product."updatedAt" IS NOT NULL
          AND (
            staged_product."updatedAt" IS NULL
            OR previous_product."updatedAt" > staged_product."updatedAt"
          )
        )
      )
  `;

  const productIds = candidates
    .map((row) => String(row?.id || "").trim())
    .filter(Boolean);

  let preserved = 0;
  for (const productIdChunk of chunk(productIds)) {
    const products = await tx.product.findMany({
      where: {
        shop,
        mirrorBatchId: previousBatchId,
        id: { in: productIdChunk },
      },
    });
    if (!products.length) continue;

    const variants = await tx.variant.findMany({
      where: {
        shop,
        mirrorBatchId: previousBatchId,
        productId: { in: productIdChunk },
      },
    });
    const variantIds = variants.map((variant) => variant.id);

    const inventoryItems = await tx.inventoryItemMirror.findMany({
      where: {
        shop,
        mirrorBatchId: previousBatchId,
        productId: { in: productIdChunk },
      },
    });
    const inventoryItemIds = inventoryItems.map((item) => item.id);

    const inventoryLevels = inventoryItemIds.length
      ? await tx.inventoryLevelMirror.findMany({
          where: {
            shop,
            mirrorBatchId: previousBatchId,
            inventoryItemId: { in: inventoryItemIds },
          },
        })
      : [];

    const productCollections = await tx.productCollection.findMany({
      where: {
        shop,
        mirrorBatchId: previousBatchId,
        productId: { in: productIdChunk },
      },
    });

    const productMedia = await tx.productMediaMirror.findMany({
      where: {
        shop,
        mirrorBatchId: previousBatchId,
        productId: { in: productIdChunk },
      },
    });

    const metafields = await tx.metafieldMirror.findMany({
      where: {
        shop,
        mirrorBatchId: previousBatchId,
        OR: [
          { ownerType: "PRODUCT", ownerId: { in: productIdChunk } },
          ...(variantIds.length
            ? [{ ownerType: "VARIANT", ownerId: { in: variantIds } }]
            : []),
        ],
      },
    });

    if (inventoryItemIds.length) {
      await tx.inventoryLevelMirror.deleteMany({
        where: {
          shop,
          mirrorBatchId: syncBatchId,
          inventoryItemId: { in: inventoryItemIds },
        },
      });
    }
    await tx.inventoryItemMirror.deleteMany({
      where: {
        shop,
        mirrorBatchId: syncBatchId,
        productId: { in: productIdChunk },
      },
    });
    await tx.productCollection.deleteMany({
      where: {
        shop,
        mirrorBatchId: syncBatchId,
        productId: { in: productIdChunk },
      },
    });
    await tx.productMediaMirror.deleteMany({
      where: {
        shop,
        mirrorBatchId: syncBatchId,
        productId: { in: productIdChunk },
      },
    });
    await tx.metafieldMirror.deleteMany({
      where: {
        shop,
        mirrorBatchId: syncBatchId,
        OR: [
          { ownerType: "PRODUCT", ownerId: { in: productIdChunk } },
          ...(variantIds.length
            ? [{ ownerType: "VARIANT", ownerId: { in: variantIds } }]
            : []),
        ],
      },
    });
    await tx.variant.deleteMany({
      where: {
        shop,
        mirrorBatchId: syncBatchId,
        productId: { in: productIdChunk },
      },
    });
    await tx.product.deleteMany({
      where: {
        shop,
        mirrorBatchId: syncBatchId,
        id: { in: productIdChunk },
      },
    });

    await tx.product.createMany({
      data: products.map((row) => ({ ...row, mirrorBatchId: syncBatchId })),
      skipDuplicates: true,
    });
    if (variants.length) {
      await tx.variant.createMany({
        data: variants.map((row) => ({ ...row, mirrorBatchId: syncBatchId })),
        skipDuplicates: true,
      });
    }
    if (inventoryItems.length) {
      await tx.inventoryItemMirror.createMany({
        data: inventoryItems.map((row) => ({ ...row, mirrorBatchId: syncBatchId })),
        skipDuplicates: true,
      });
    }
    if (inventoryLevels.length) {
      await tx.inventoryLevelMirror.createMany({
        data: inventoryLevels.map((row) => ({ ...row, mirrorBatchId: syncBatchId })),
        skipDuplicates: true,
      });
    }
    if (productCollections.length) {
      await tx.productCollection.createMany({
        data: productCollections.map((row) => ({ ...row, mirrorBatchId: syncBatchId })),
        skipDuplicates: true,
      });
    }
    if (productMedia.length) {
      await tx.productMediaMirror.createMany({
        data: productMedia.map((row) => ({ ...row, mirrorBatchId: syncBatchId })),
        skipDuplicates: true,
      });
    }
    if (metafields.length) {
      await tx.metafieldMirror.createMany({
        data: metafields.map((row) => ({ ...row, mirrorBatchId: syncBatchId })),
        skipDuplicates: true,
      });
    }

    preserved += products.length;
  }

  return preserved;
}

export async function activateProductMirrorBatch({
  shop,
  syncBatchId,
  totalProductsProcessed = null,
  totalVariantsProcessed = null,
  syncHistoryId,
}) {
  const store = await ensureStoreForShop({ shop });
  const mirrorState = await prisma.store.findUnique({
    where: { shopUrl: shop },
    select: { activeMirrorBatchId: true },
  });

  const previousBatchId = mirrorState?.activeMirrorBatchId || null;
  const completedAt = new Date();

  await prisma.$transaction(async (tx) => {
    const transactionStore = await ensureStoreForShop({ shop }, tx);
    if (previousBatchId && previousBatchId !== syncBatchId) {
      await preserveNewerPreviousBatchProducts(tx, {
        shop,
        previousBatchId,
        syncBatchId,
      });
    }

    const shouldCountFinalRows = Boolean(previousBatchId && previousBatchId !== syncBatchId);
    const finalProductCount = shouldCountFinalRows || typeof totalProductsProcessed !== "number"
      ? await tx.product.count({ where: { shop, mirrorBatchId: syncBatchId } })
      : totalProductsProcessed;
    const finalVariantCount = shouldCountFinalRows || typeof totalVariantsProcessed !== "number"
      ? await tx.variant.count({ where: { shop, mirrorBatchId: syncBatchId } })
      : totalVariantsProcessed;

    logStoreMutation("activateProductMirrorBatch.store.updateMany", {
      shop,
      storeId: transactionStore.id || store.id,
      syncHistoryId,
      syncBatchId,
    });
    const storeActivated = await tx.store.updateMany({
      where: {
        shopUrl: shop,
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
        storeTotalProducts: finalProductCount,
        productInitialSyncProgress: finalProductCount,
        lastProductSyncAt: completedAt,
        productSyncStartedAt: null,
        productSyncRecoveryRequired: false,
      },
    });
    if (storeActivated.count !== 1) {
      console.warn("[sync:store_activation_transition_unexpected]", {
        shop,
        syncBatchId,
        syncHistoryId,
        updatedCount: storeActivated.count,
      });
    }

    if (syncHistoryId) {
      const updatedSyncHistory = await tx.syncHistory.updateMany({
        where: {
          id: syncHistoryId,
          shop,
          status: "processing",
          stage: {
            in: ["MIRROR_STAGING", "INGESTING_TO_STAGING_BATCH", "VALIDATING_BATCH", "ACTIVATING_BATCH"],
          },
        },
        data: {
          status: "completed",
          stage: "MIRROR_ACTIVATED",
          recordCount: finalProductCount,
          completedAt,
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
          actualProducts: finalProductCount,
          actualVariants: finalVariantCount,
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
          actualProducts: finalProductCount,
          actualVariants: finalVariantCount,
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

    await tx.mirrorReconcileSignal.updateMany({
      where: { shop, status: "pending" },
      data: {
        status: "resolved",
        reconciledAt: completedAt,
        updatedAt: completedAt,
      },
    });
  }, {
    maxWait: 10_000,
    timeout: 60_000,
  });
  await clearProductSyncCache(shop);
}

export async function updateInitialSyncProgress({
  shop,
  totalProductsProcessed,
}) {
  const store = await ensureStoreForShop({ shop });
  logStoreMutation("updateInitialSyncProgress.store.updateMany", {
    shop,
    storeId: store.id,
  });
  await prisma.store.updateMany({
    where: { shopUrl: shop },
    data: {
      productInitialSyncProgress: totalProductsProcessed,
      syncProgressStage: "MIRROR_STAGING",
    },
  });
}
