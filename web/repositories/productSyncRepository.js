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

async function upsertMirrorBatch(
  tx,
  {
    id,
    shop,
    syncHistoryId = null,
    bulkOperationId = null,
    resourceType = "PRODUCT_CATALOG",
    status = "SYNC_REQUESTED",
    expectedActiveBatchId = undefined,
    syncStartSequence = undefined,
  },
) {
  const optionalData = {
    ...(expectedActiveBatchId !== undefined
      ? { expectedActiveBatchId }
      : {}),
    ...(syncStartSequence !== undefined ? { syncStartSequence } : {}),
  };

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
      ...optionalData,
    },
    create: {
      id,
      shop,
      syncHistoryId,
      bulkOperationId,
      resourceType,
      status,
      ...optionalData,
    },
  });
}

export async function markMirrorBatchStatus({
  shop,
  syncBatchId,
  status,
  failureReason = null,
  counts = {},
  finalizedSequence = undefined,
}) {
  if (!shop || !syncBatchId) {
    throw new Error("shop and syncBatchId are required");
  }

  const data = {
    status,
    ...(failureReason ? { failureReason } : {}),
    ...(status === "FAILED" ? { failedAt: new Date() } : {}),
    ...(status === "FINALIZED" ? { finalizedAt: new Date() } : {}),
    ...(status === "ACTIVE" ? { activatedAt: new Date() } : {}),
    ...(finalizedSequence !== undefined ? { finalizedSequence } : {}),
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
    where: { id: syncBatchId, shop },
    data,
  });

  if (result.count !== 1) {
    throw buildCodedError(
      "MIRROR_BATCH_NOT_FOUND",
      `Mirror batch ${syncBatchId} was not found for shop ${shop}`,
    );
  }
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

  return prisma.$transaction(
    async (tx) => {
      const store = await ensureStoreForShop({ shop }, tx);
      const syncStartSequence = await getLatestMutationSequence(tx, shop);
      const expectedActiveBatchId = store.activeMirrorBatchId ?? null;

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
        expectedActiveBatchId,
        syncStartSequence,
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
  syncBatchId,
  syncHistoryId = null,
}) {
  await prisma.$transaction(
    async (tx) => {
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
        await tx.syncHistory.updateMany({
          where: { id: syncHistoryId, shop, status: "processing" },
          data: { stage: "MIRROR_STAGING" },
        });
      }

      await tx.mirrorBatch.updateMany({
        where: {
          id: syncBatchId,
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
        where: { shop, mirrorBatchId: syncBatchId },
      });
      await tx.inventoryItemMirror.deleteMany({
        where: { shop, mirrorBatchId: syncBatchId },
      });
      await tx.productCollection.deleteMany({
        where: { shop, mirrorBatchId: syncBatchId },
      });
      await tx.productMediaMirror.deleteMany({
        where: { shop, mirrorBatchId: syncBatchId },
      });
      await tx.metafieldMirror.deleteMany({
        where: { shop, mirrorBatchId: syncBatchId },
      });
      await tx.variant.deleteMany({
        where: { shop, mirrorBatchId: syncBatchId },
      });
      await tx.product.deleteMany({
        where: { shop, mirrorBatchId: syncBatchId },
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
  syncBatchId,
}) {
  if (!syncBatchId) throw new Error("syncBatchId is required");

  const operations = [];

  const pushCreateMany = (model, rows) => {
    if (!Array.isArray(rows) || rows.length === 0) return;
    operations.push(
      model.createMany({
        data: rows.map((row) => ({
          ...row,
          mirrorBatchId: syncBatchId,
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
  syncBatchId,
}) {
  const batch = await prisma.mirrorBatch.findFirst({
    where: { id: syncBatchId, shop },
    select: { syncStartSequence: true },
  });

  if (!batch) throw buildCodedError("MIRROR_BATCH_NOT_FOUND", syncBatchId);

  const tombstones = await prisma.productTombstone.findMany({
    where: {
      shop,
      mutationSequence: {
        gt: batch.syncStartSequence ?? 0n,
      },
    },
    select: { productId: true },
  });

  const productIds = [...new Set(tombstones.map((row) => row.productId))];
  if (productIds.length === 0) return 0;

  const variants = await prisma.variant.findMany({
    where: {
      shop,
      mirrorBatchId: syncBatchId,
      productId: { in: productIds },
    },
    select: { id: true },
  });
  const variantIds = variants.map((row) => row.id);

  const inventoryItems = await prisma.inventoryItemMirror.findMany({
    where: {
      shop,
      mirrorBatchId: syncBatchId,
      productId: { in: productIds },
    },
    select: { id: true },
  });
  const inventoryItemIds = inventoryItems.map((row) => row.id);

  await prisma.$transaction([
    prisma.inventoryLevelMirror.deleteMany({
      where: {
        shop,
        mirrorBatchId: syncBatchId,
        ...(inventoryItemIds.length > 0
          ? { inventoryItemId: { in: inventoryItemIds } }
          : { inventoryItemId: "__none__" }),
      },
    }),
    prisma.inventoryItemMirror.deleteMany({
      where: {
        shop,
        mirrorBatchId: syncBatchId,
        productId: { in: productIds },
      },
    }),
    prisma.productCollection.deleteMany({
      where: {
        shop,
        mirrorBatchId: syncBatchId,
        productId: { in: productIds },
      },
    }),
    prisma.productMediaMirror.deleteMany({
      where: {
        shop,
        mirrorBatchId: syncBatchId,
        productId: { in: productIds },
      },
    }),
    prisma.metafieldMirror.deleteMany({
      where: {
        shop,
        mirrorBatchId: syncBatchId,
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
        mirrorBatchId: syncBatchId,
        productId: { in: productIds },
      },
    }),
    prisma.product.deleteMany({
      where: {
        shop,
        mirrorBatchId: syncBatchId,
        id: { in: productIds },
      },
    }),
  ]);

  return productIds.length;
}

export async function validateAndFinalizeProductMirrorBatch({
  shop,
  syncBatchId,
  unresolvedChildCount,
}) {
  if (unresolvedChildCount !== 0) {
    throw buildCodedError(
      "MIRROR_UNRESOLVED_CHILDREN",
      `Candidate contains ${unresolvedChildCount} unresolved child rows`,
    );
  }

  await applyProductTombstonesToCandidate({ shop, syncBatchId });

  const [
    productCount,
    variantCount,
    metafieldCount,
    collectionCount,
    invalidVariantCount,
    invalidInventoryItemCount,
  ] = await Promise.all([
    prisma.product.count({ where: { shop, mirrorBatchId: syncBatchId } }),
    prisma.variant.count({ where: { shop, mirrorBatchId: syncBatchId } }),
    prisma.metafieldMirror.count({
      where: { shop, mirrorBatchId: syncBatchId },
    }),
    prisma.productCollection.count({
      where: { shop, mirrorBatchId: syncBatchId },
    }),
    prisma.$queryRaw`
      SELECT COUNT(*)::int AS "count"
      FROM "Variant" v
      LEFT JOIN "Product" p
        ON p."shop" = v."shop"
       AND p."id" = v."productId"
       AND p."mirrorBatchId" = v."mirrorBatchId"
      WHERE v."shop" = ${shop}
        AND v."mirrorBatchId" = ${syncBatchId}
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
        AND i."mirrorBatchId" = ${syncBatchId}
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

  const finalizedSequence = await getLatestMutationSequence(prisma, shop);

  const updated = await prisma.mirrorBatch.updateMany({
    where: {
      id: syncBatchId,
      shop,
      status: {
        in: ["INGESTING_TO_STAGING_BATCH", "VALIDATING_BATCH"],
      },
    },
    data: {
      status: "FINALIZED",
      finalizedSequence,
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
    finalizedSequence,
  };
}

export async function activateProductMirrorBatch({
  shop,
  syncBatchId,
  expectedActiveBatchId,
  syncHistoryId,
}) {
  const completedAt = new Date();

  const activation = await prisma.$transaction(
    async (tx) => {
      const candidate = await tx.mirrorBatch.findFirst({
        where: {
          id: syncBatchId,
          shop,
          resourceType: "PRODUCT_CATALOG",
          status: "FINALIZED",
          expectedActiveBatchId,
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
          expectedActiveBatchId === null
            ? { shopUrl: shop, activeMirrorBatchId: null }
            : {
                shopUrl: shop,
                activeMirrorBatchId: expectedActiveBatchId,
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
          storeTotalProducts: candidate.actualProducts ?? 0,
          productInitialSyncProgress: candidate.actualProducts ?? 0,
          lastProductSyncAt: completedAt,
          productSyncStartedAt: null,
          productSyncRecoveryRequired: false,
        },
      });

      if (storeActivated.count !== 1) {
        throw buildCodedError(
          "STALE_ACTIVE_GENERATION",
          "Active mirror changed before candidate promotion",
        );
      }

      const candidateActivated = await tx.mirrorBatch.updateMany({
        where: {
          id: syncBatchId,
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

      if (
        expectedActiveBatchId &&
        expectedActiveBatchId !== syncBatchId
      ) {
        await tx.mirrorBatch.updateMany({
          where: {
            id: expectedActiveBatchId,
            shop,
            status: "ACTIVE",
          },
          data: {
            status: "RETIRED",
            retiredAt: completedAt,
          },
        });
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
          status: "pending",
          mutationSequence: {
            lte: candidate.finalizedSequence ?? 0n,
          },
        },
        data: {
          status: "resolved",
          reconciledAt: completedAt,
          updatedAt: completedAt,
        },
      });

      return {
        retiredBatchId:
          expectedActiveBatchId && expectedActiveBatchId !== syncBatchId
            ? expectedActiveBatchId
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

        if (history.syncBatchId) {
          await tx.mirrorBatch.updateMany({
            where: { id: history.syncBatchId, shop },
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
    const hasActiveMirror = Boolean(store.activeMirrorBatchId);

    await tx.store.updateMany({
      where: { shopUrl: shop },
      data: {
        isProductSyncing: false,
        isProductInitialySyning: false,
        syncProgressStage: "IDLE",
        shopifyBulkJobCompleted: false,
        mirrorHealthState: hasActiveMirror ? "DEGRADED" : "UNSAFE",
        staleReason: "FULL_SYNC_FAILED",
        repairRequired: !hasActiveMirror,
        mirrorUnsafeSince: hasActiveMirror ? null : new Date(),
        productSyncRecoveryRequired: true,
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
