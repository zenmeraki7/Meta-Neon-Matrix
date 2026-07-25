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
import { enqueueRetiredMirrorCleanup } from "../Jobs/Queues/mirrorCleanupQueue.js";

const PRODUCT_SYNC_CACHE_KEYS = [":sync_details", ":sync_summary"];

function buildCodedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function getLatestMutationSequence(tx, shop) {
  const latest = await tx.mirrorMutationJournal.findFirst({
    where: { shop },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  return latest?.sequence ?? 0n;
}

async function transitionMirrorSyncLedgerBySyncHistoryId(
  tx,
  { shop, syncHistoryId, from, to, data = {} },
) {
  if (!shop || !syncHistoryId) return 0;

  const updated = await tx.operationFingerprint.updateMany({
    where: {
      shop,
      operationType: "MIRROR_SYNC",
      fingerprintResourceType: "sync_history",
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

async function upsertMirrorBatch(
  tx,
  {
    id,
    shop,
    syncHistoryId = null,
    shopifyBulkOperationId = null,
    mirrorResourceType = "PRODUCT_CATALOG",
    status = "SYNC_REQUESTED",
    expectedPreviousActiveBatchId = undefined,
    replayStartSequence = undefined,
  },
) {
  const optionalData = {
    ...(expectedPreviousActiveBatchId !== undefined
      ? { expectedPreviousActiveBatchId }
      : {}),
    ...(replayStartSequence !== undefined ? { replayStartSequence } : {}),
  };

  return tx.mirrorBatch.upsert({
    where: { shop_id: { shop, id } },
    update: {
      shop,
      syncHistoryId,
      shopifyBulkOperationId,
      mirrorResourceType,
      status,
      failureReason: null,
      failedAt: null,
      ...optionalData,
    },
    create: {
      id,
      shop,
      syncHistoryId,
      shopifyBulkOperationId,
      mirrorResourceType,
      status,
      ...optionalData,
    },
  });
}

export async function markMirrorBatchStatus({
  shop,
  mirrorBatchId,
  status,
  failureReason = null,
  counts = {},
  replayFinalizedThroughSequence = undefined,
}) {
  if (!shop || !mirrorBatchId) {
    throw new Error("shop and mirrorBatchId are required");
  }

  const data = {
    status,
    ...(failureReason ? { failureReason } : {}),
    ...(status === "FAILED" ? { failedAt: new Date() } : {}),
    ...(status === "FINALIZED" ? { finalizedAt: new Date() } : {}),
    ...(status === "ACTIVE" ? { activatedAt: new Date() } : {}),
    ...(replayFinalizedThroughSequence !== undefined ? { replayFinalizedThroughSequence } : {}),
    ...(typeof counts.actualProducts === "number"
      ? { actualProducts: counts.actualProducts }
      : {}),
    ...(typeof counts.actualVariants === "number"
      ? { actualVariants: counts.actualVariants }
      : {}),
    ...(typeof counts.actualCollections === "number"
      ? { actualCollections: counts.actualCollections }
      : {}),
    ...(typeof counts.actualMetafields === "number"
      ? { actualMetafields: counts.actualMetafields }
      : {}),
  };

  const result = await prisma.mirrorBatch.updateMany({
    where: { id: mirrorBatchId, shop },
    data,
  });

  if (result.count !== 1) {
    throw buildCodedError(
      "MIRROR_BATCH_NOT_FOUND",
      `Mirror batch ${mirrorBatchId} was not found for shop ${shop}`,
    );
  }
}

export async function markProductSyncStarted({ shop }) {
  await markFullSyncStarted(shop);
}

export async function queueProductSyncStart({
  shop,
  shopifyBulkOperationId,
  isInitialSync = false,
}) {
  const mirrorBatchId = createMirrorBatchId("product_sync");

  return prisma.$transaction(
    async (tx) => {
      const store = await ensureStoreForShop({ shop }, tx);
      const replayStartSequence = await getLatestMutationSequence(tx, shop);
      const expectedPreviousActiveBatchId = store.currentProductMirrorBatchId ?? null;

      logStoreMutation("queueProductSyncStart.store.updateMany", {
        shop,
        storeId: store.id,
        mirrorBatchId,
        shopifyBulkOperationId,
      });

      await tx.store.updateMany({
        where: { shopUrl: shop },
        data: {
          isProductSyncing: true,
          isProductInitiallySyncing: isInitialSync,
          hasCompletedShopifyBulkJob: false,
          syncProgressStage: "SHOPIFY_BULK_RUNNING",
          staleReason: "FULL_SYNC_RUNNING",
          lastSyncErrorSummary: null,
          mirrorUnsafeSince: new Date(),
        },
      });

      const createdHistory = await tx.syncHistory.create({
        data: {
          shop,
          shopifyBulkOperationId,
          mirrorBatchId,
          status: "processing",
          stage: "SHOPIFY_BULK_RUNNING",
          operationType: "Product",
          isInitialProductSync: isInitialSync,
          recordCount: 0,
          duration: 0,
        },
      });

      await upsertMirrorBatch(tx, {
        id: mirrorBatchId,
        shop,
        syncHistoryId: createdHistory.id,
        shopifyBulkOperationId,
        mirrorResourceType: "PRODUCT_CATALOG",
        status: "BULK_OPERATION_STARTED",
        expectedPreviousActiveBatchId,
        replayStartSequence,
      });

      return createdHistory;
    },
    {
      isolationLevel: "Serializable",
      maxWait: 10_000,
      timeout: 20_000,
    },
  );
}

export async function clearProductSyncCache(shop) {
  await Promise.allSettled(
    PRODUCT_SYNC_CACHE_KEYS.map((suffix) =>
      clearKeyCaches(`${shop}${suffix}`),
    ),
  );
}

export async function stageProductMirrorBatch({
  shop,
  mirrorBatchId,
  syncHistoryId = null,
}) {
  await prisma.$transaction(
    async (tx) => {
      const store = await ensureStoreForShop({ shop }, tx);

      logStoreMutation("stageProductMirrorBatch.store.updateMany", {
        shop,
        storeId: store.id,
        syncHistoryId,
        mirrorBatchId,
      });

      await tx.store.updateMany({
        where: { shopUrl: shop },
        data: {
          syncProgressStage: "MIRROR_STAGING",
          staleReason: "FULL_SYNC_RUNNING",
        },
      });

      if (syncHistoryId) {
        await tx.syncHistory.updateMany({
          where: { id: syncHistoryId, shop, status: "processing" },
          data: { stage: "MIRROR_STAGING" },
        });
      }

      await tx.mirrorBatch.updateMany({
        where: {
          id: mirrorBatchId,
          shop,
          status: {
            in: [
              "BULK_OPERATION_STARTED",
              "FILE_DOWNLOADED",
              "INGESTING_TO_STAGING_BATCH",
            ],
          },
        },
        data: { status: "INGESTING_TO_STAGING_BATCH" },
      });

      await transitionMirrorSyncLedgerBySyncHistoryId(tx, {
        shop,
        syncHistoryId,
        from: ["RUNNING", "STARTING_BULK_QUERY"],
        to: "INGESTING",
      });

      await tx.inventoryLevelMirror.deleteMany({
        where: { shop, mirrorBatchId: mirrorBatchId },
      });
      await tx.inventoryItemMirror.deleteMany({
        where: { shop, mirrorBatchId: mirrorBatchId },
      });
      await tx.productCollection.deleteMany({
        where: { shop, mirrorBatchId: mirrorBatchId },
      });
      await tx.productMediaMirror.deleteMany({
        where: { shop, mirrorBatchId: mirrorBatchId },
      });
      await tx.metafieldMirror.deleteMany({
        where: { shop, mirrorBatchId: mirrorBatchId },
      });
      await tx.variant.deleteMany({
        where: { shop, mirrorBatchId: mirrorBatchId },
      });
      await tx.product.deleteMany({
        where: { shop, mirrorBatchId: mirrorBatchId },
      });
    },
    {
      maxWait: 10_000,
      timeout: 60_000,
    },
  );
}

export async function insertProductMirrorBatch({
  productRows = [],
  variantRows = [],
  inventoryItemRows = [],
  inventoryLevelRows = [],
  productCollectionRows = [],
  metafieldRows = [],
  productMediaRows = [],
  mirrorBatchId,
}) {
  if (!mirrorBatchId) throw new Error("mirrorBatchId is required");

  const operations = [];

  const pushCreateMany = (model, rows) => {
    if (!Array.isArray(rows) || rows.length === 0) return;
    operations.push(
      model.createMany({
        data: rows.map((row) => ({
          ...row,
          mirrorBatchId: mirrorBatchId,
        })),
        skipDuplicates: true,
      }),
    );
  };

  pushCreateMany(prisma.product, productRows);
  pushCreateMany(prisma.variant, variantRows);
  pushCreateMany(prisma.inventoryItemMirror, inventoryItemRows);
  pushCreateMany(prisma.inventoryLevelMirror, inventoryLevelRows);
  pushCreateMany(prisma.productCollection, productCollectionRows);
  pushCreateMany(prisma.metafieldMirror, metafieldRows);
  pushCreateMany(prisma.productMediaMirror, productMediaRows);

  if (operations.length > 0) {
    await prisma.$transaction(operations);
  }
}

export async function applyProductTombstonesToCandidate({
  shop,
  mirrorBatchId,
}) {
  const batch = await prisma.mirrorBatch.findFirst({
    where: { id: mirrorBatchId, shop },
    select: { replayStartSequence: true },
  });

  if (!batch) throw buildCodedError("MIRROR_BATCH_NOT_FOUND", mirrorBatchId);

  const tombstones = await prisma.productTombstone.findMany({
    where: {
      shop,
      tombstoneMutationSequence: {
        gt: batch.replayStartSequence ?? 0n,
      },
    },
    select: { productId: true },
  });

  const productIds = [...new Set(tombstones.map((row) => row.productId))];
  if (productIds.length === 0) return 0;

  const variants = await prisma.variant.findMany({
    where: {
      shop,
      mirrorBatchId: mirrorBatchId,
      productId: { in: productIds },
    },
    select: { id: true },
  });
  const variantIds = variants.map((row) => row.id);

  const inventoryItems = await prisma.inventoryItemMirror.findMany({
    where: {
      shop,
      mirrorBatchId: mirrorBatchId,
      productId: { in: productIds },
    },
    select: { id: true },
  });
  const inventoryItemIds = inventoryItems.map((row) => row.id);

  await prisma.$transaction([
    prisma.inventoryLevelMirror.deleteMany({
      where: {
        shop,
        mirrorBatchId: mirrorBatchId,
        ...(inventoryItemIds.length > 0
          ? { inventoryItemId: { in: inventoryItemIds } }
          : { inventoryItemId: "__none__" }),
      },
    }),
    prisma.inventoryItemMirror.deleteMany({
      where: {
        shop,
        mirrorBatchId: mirrorBatchId,
        productId: { in: productIds },
      },
    }),
    prisma.productCollection.deleteMany({
      where: {
        shop,
        mirrorBatchId: mirrorBatchId,
        productId: { in: productIds },
      },
    }),
    prisma.productMediaMirror.deleteMany({
      where: {
        shop,
        mirrorBatchId: mirrorBatchId,
        productId: { in: productIds },
      },
    }),
    prisma.metafieldMirror.deleteMany({
      where: {
        shop,
        mirrorBatchId: mirrorBatchId,
        OR: [
          { ownerType: "PRODUCT", ownerId: { in: productIds } },
          ...(variantIds.length > 0
            ? [{ ownerType: "VARIANT", ownerId: { in: variantIds } }]
            : []),
        ],
      },
    }),
    prisma.variant.deleteMany({
      where: {
        shop,
        mirrorBatchId: mirrorBatchId,
        productId: { in: productIds },
      },
    }),
    prisma.product.deleteMany({
      where: {
        shop,
        mirrorBatchId: mirrorBatchId,
        id: { in: productIds },
      },
    }),
  ]);

  return productIds.length;
}

export async function validateAndFinalizeProductMirrorBatch({
  shop,
  mirrorBatchId,
  unresolvedChildCount,
}) {
  if (unresolvedChildCount !== 0) {
    throw buildCodedError(
      "MIRROR_UNRESOLVED_CHILDREN",
      `Candidate contains ${unresolvedChildCount} unresolved child rows`,
    );
  }

  await applyProductTombstonesToCandidate({ shop, mirrorBatchId });

  const [
    productCount,
    variantCount,
    metafieldCount,
    collectionCount,
    invalidVariantCount,
    invalidInventoryItemCount,
  ] = await Promise.all([
    prisma.product.count({ where: { shop, mirrorBatchId: mirrorBatchId } }),
    prisma.variant.count({ where: { shop, mirrorBatchId: mirrorBatchId } }),
    prisma.metafieldMirror.count({
      where: { shop, mirrorBatchId: mirrorBatchId },
    }),
    prisma.productCollection.count({
      where: { shop, mirrorBatchId: mirrorBatchId },
    }),
    prisma.$queryRaw`
      SELECT COUNT(*)::int AS "count"
      FROM "Variant" v
      LEFT JOIN "Product" p
        ON p."shop" = v."shop"
       AND p."id" = v."productId"
       AND p."mirrorBatchId" = v."mirrorBatchId"
      WHERE v."shop" = ${shop}
        AND v."mirrorBatchId" = ${mirrorBatchId}
        AND p."id" IS NULL
    `,
    prisma.$queryRaw`
      SELECT COUNT(*)::int AS "count"
      FROM "InventoryItemMirror" i
      LEFT JOIN "Variant" v
        ON v."shop" = i."shop"
       AND v."id" = i."variantId"
       AND v."mirrorBatchId" = i."mirrorBatchId"
      WHERE i."shop" = ${shop}
        AND i."mirrorBatchId" = ${mirrorBatchId}
        AND v."id" IS NULL
    `,
  ]);

  const invalidVariants = Number(invalidVariantCount?.[0]?.count || 0);
  const invalidInventoryItems = Number(
    invalidInventoryItemCount?.[0]?.count || 0,
  );

  if (invalidVariants > 0 || invalidInventoryItems > 0) {
    throw buildCodedError(
      "MIRROR_RELATION_VALIDATION_FAILED",
      `Invalid variants=${invalidVariants}, invalidInventoryItems=${invalidInventoryItems}`,
    );
  }

  const replayFinalizedThroughSequence = await getLatestMutationSequence(prisma, shop);

  const updated = await prisma.mirrorBatch.updateMany({
    where: {
      id: mirrorBatchId,
      shop,
      status: {
        in: ["INGESTING_TO_STAGING_BATCH", "VALIDATING_BATCH"],
      },
    },
    data: {
      status: "FINALIZED",
      replayFinalizedThroughSequence,
      finalizedAt: new Date(),
      actualProducts: productCount,
      actualVariants: variantCount,
      actualMetafields: metafieldCount,
      actualCollections: collectionCount,
    },
  });

  if (updated.count !== 1) {
    throw buildCodedError(
      "MIRROR_FINALIZE_TRANSITION_REJECTED",
      "Candidate could not transition to FINALIZED",
    );
  }

  return {
    productCount,
    variantCount,
    metafieldCount,
    collectionCount,
    replayFinalizedThroughSequence,
  };
}

export async function activateProductMirrorBatch({
  shop,
  mirrorBatchId,
  expectedPreviousActiveBatchId,
  syncHistoryId,
}) {
  const completedAt = new Date();

  const activation = await prisma.$transaction(
    async (tx) => {
      const candidate = await tx.mirrorBatch.findFirst({
        where: {
          id: mirrorBatchId,
          shop,
          mirrorResourceType: "PRODUCT_CATALOG",
          status: "FINALIZED",
          expectedPreviousActiveBatchId,
        },
      });

      if (!candidate) {
        throw buildCodedError(
          "CANDIDATE_NOT_FINALIZED",
          "Candidate is missing, stale, or not FINALIZED",
        );
      }

      const storeActivated = await tx.store.updateMany({
        where:
          expectedPreviousActiveBatchId === null
            ? { shopUrl: shop, currentProductMirrorBatchId: null }
            : {
                shopUrl: shop,
                currentProductMirrorBatchId: expectedPreviousActiveBatchId,
              },
        data: {
          currentProductMirrorBatchId: mirrorBatchId,
          mirrorMutationVersion: { increment: 1 },
          mirrorHealthState: "HEALTHY",
          staleReason: null,
          requiresMirrorRepair: false,
          mirrorUnsafeSince: null,
          lastSyncErrorSummary: null,
          lastFullSyncAt: completedAt,
          isProductSyncing: false,
          isProductInitiallySyncing: false,
          syncProgressStage: "IDLE",
          hasCompletedShopifyBulkJob: true,
          storeTotalProducts: candidate.actualProducts ?? 0,
          productInitialSyncProgress: candidate.actualProducts ?? 0,
          lastProductSyncAt: completedAt,
          productSyncStartedAt: null,
          requiresProductSyncRecovery: false,
        },
      });

      if (storeActivated.count !== 1) {
        throw buildCodedError(
          "STALE_ACTIVE_GENERATION",
          "Active mirror changed before candidate promotion",
        );
      }

      // Retire the previous generation before activating the candidate. The
      // partial unique index enforces one ACTIVE product catalog per shop, and
      // the surrounding transaction rolls this back if promotion fails.
      if (
        expectedPreviousActiveBatchId &&
        expectedPreviousActiveBatchId !== mirrorBatchId
      ) {
        await tx.mirrorBatch.updateMany({
          where: {
            id: expectedPreviousActiveBatchId,
            shop,
            status: "ACTIVE",
          },
          data: {
            status: "RETIRED",
            retiredAt: completedAt,
          },
        });
      }

      const candidateActivated = await tx.mirrorBatch.updateMany({
        where: {
          id: mirrorBatchId,
          shop,
          status: "FINALIZED",
        },
        data: {
          status: "ACTIVE",
          activatedAt: completedAt,
        },
      });

      if (candidateActivated.count !== 1) {
        throw buildCodedError(
          "CANDIDATE_ACTIVATION_REJECTED",
          "Candidate activation state transition failed",
        );
      }

      if (syncHistoryId) {
        const historyUpdated = await tx.syncHistory.updateMany({
          where: {
            id: syncHistoryId,
            shop,
            status: "processing",
          },
          data: {
            status: "completed",
            stage: "MIRROR_ACTIVATED",
            recordCount: candidate.actualProducts ?? 0,
            completedAt,
          },
        });

        if (historyUpdated.count !== 1) {
          throw buildCodedError(
            "SYNC_HISTORY_ACTIVATION_TRANSITION_REJECTED",
            "Sync history completion transition failed",
          );
        }

        await transitionMirrorSyncLedgerBySyncHistoryId(tx, {
          shop,
          syncHistoryId,
          from: ["QUEUED", "STARTING_BULK_QUERY", "RUNNING", "INGESTING"],
          to: "COMPLETED",
        });
      }

      await tx.mirrorReconcileSignal.updateMany({
        where: {
          shop,
          status: "PENDING",
          mirrorMutationSequence: {
            lte: candidate.replayFinalizedThroughSequence ?? 0n,
          },
        },
        data: {
          status: "resolved",
          reconciliationCompletedAt: completedAt,
          updatedAt: completedAt,
        },
      });

      return {
        retiredBatchId:
          expectedPreviousActiveBatchId && expectedPreviousActiveBatchId !== mirrorBatchId
            ? expectedPreviousActiveBatchId
            : null,
      };
    },
    {
      isolationLevel: "Serializable",
      maxWait: 10_000,
      timeout: 15_000,
    },
  );

  await clearProductSyncCache(shop);

  if (activation.retiredBatchId) {
    await enqueueRetiredMirrorCleanup({
      shop,
      mirrorBatchId: activation.retiredBatchId,
    });
  }

  return activation;
}

export async function markSyncHistoryFailed({
  shop,
  syncHistoryId,
  errorMessage,
}) {
  await prisma.$transaction(async (tx) => {
    if (syncHistoryId) {
      const history = await tx.syncHistory.findFirst({
        where: { id: syncHistoryId, shop },
      });

      if (history) {
        await tx.syncHistory.updateMany({
          where: {
            id: syncHistoryId,
            shop,
            status: "processing",
          },
          data: {
            status: "failed",
            stage: "FAILED",
            errorMessage,
          },
        });

        if (history.mirrorBatchId) {
          await tx.mirrorBatch.updateMany({
            where: { id: history.mirrorBatchId, shop },
            data: {
              status: "FAILED",
              failedAt: new Date(),
              failureReason: errorMessage,
            },
          });
        }
      }
    }

    const store = await ensureStoreForShop({ shop }, tx);
    const hasActiveMirror = Boolean(store.currentProductMirrorBatchId);

    await tx.store.updateMany({
      where: { shopUrl: shop },
      data: {
        isProductSyncing: false,
        isProductInitiallySyncing: false,
        syncProgressStage: "IDLE",
        hasCompletedShopifyBulkJob: false,
        mirrorHealthState: hasActiveMirror ? "DEGRADED" : "UNSAFE",
        staleReason: "FULL_SYNC_FAILED",
        requiresMirrorRepair: !hasActiveMirror,
        mirrorUnsafeSince: hasActiveMirror ? null : new Date(),
        requiresProductSyncRecovery: true,
        lastSyncErrorSummary: errorMessage,
      },
    });
  });

  await clearProductSyncCache(shop);
}

export async function updateInitialSyncProgress({
  shop,
  totalProductsProcessed,
}) {
  await prisma.store.updateMany({
    where: { shopUrl: shop },
    data: {
      productInitialSyncProgress: totalProductsProcessed,
      syncProgressStage: "MIRROR_STAGING",
    },
  });
}
