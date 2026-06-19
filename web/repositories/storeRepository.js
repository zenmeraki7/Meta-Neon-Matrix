import { prisma } from "../config/database.js";
import { requireShopScope } from "../utils/shopScope.js";
import { buildEncryptedTokenColumns } from "../utils/tokenCrypto.js";

const PRODUCT_SYNC_STALE_MS = Number(process.env.PRODUCT_SYNC_STALE_MS || 2 * 60 * 60 * 1000);

function withoutUndefined(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, entry]) => entry !== undefined),
  );
}

export function logStoreMutation(action, details = {}) {
  console.info("[store:mutation]", {
    action,
    shop: details.shop || null,
    storeId: details.storeId || null,
    syncHistoryId: details.syncHistoryId || null,
    syncBatchId: details.syncBatchId || null,
    bulkOperationId: details.bulkOperationId || null,
  });
}

export async function ensureStoreForShop(input, tx = prisma) {
  const command = typeof input === "string" ? { shop: input } : (input || {});
  const resolvedShop = requireShopScope(command.shop || command.shopUrl);
  const now = new Date();
  const markInstalled = command.markInstalled !== false;
  const tokenColumns = command.accessToken
    ? buildEncryptedTokenColumns(command.accessToken)
    : {};

  logStoreMutation("ensureStoreForShop.upsert", {
    shop: resolvedShop,
    storeId: command.storeId || null,
  });

  return tx.store.upsert({
    where: { shopUrl: resolvedShop },
    create: withoutUndefined({
      shopUrl: resolvedShop,
      shopEmail: command.shopEmail || "",
      ...tokenColumns,
      scope: command.scope,
      isUnInstalled: markInstalled ? false : true,
      unInstalledAt: markInstalled ? null : now,
      installedAt: markInstalled ? command.installedAt || now : null,
      lastActivityAt: now,
    }),
    update: withoutUndefined({
      ...(command.shopEmail ? { shopEmail: command.shopEmail } : {}),
      ...tokenColumns,
      ...(command.scope !== undefined ? { scope: command.scope || "" } : {}),
      ...(markInstalled ? { isUnInstalled: false, unInstalledAt: null } : {}),
      lastActivityAt: now,
    }),
  });
}

function isStaleDate(value, cutoff) {
  if (!value) return false;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) && date < cutoff;
}

function isStaleProductSyncStore(store, cutoff) {
  if (!store) return false;
  const stage = String(store.syncProgressStage || "");
  const runningStage = ["SHOPIFY_BULK_RUNNING", "MIRROR_STAGING"].includes(stage);

  if (store.isProductSyncing === true && isStaleDate(store.productSyncStartedAt, cutoff)) {
    return true;
  }

  if (
    (store.isProductSyncing === true || store.isProductInitialySyning === true || runningStage) &&
    (isStaleDate(store.mirrorUnsafeSince, cutoff) || isStaleDate(store.updatedAt, cutoff))
  ) {
    return true;
  }

  return false;
}

export async function recoverStaleProductSyncStateByShop(shop) {
  const resolvedShop = requireShopScope(shop);
  const cutoff = new Date(Date.now() - PRODUCT_SYNC_STALE_MS);

  const [store, latestRunningSync] = await Promise.all([
    prisma.store.findUnique({
      where: { shopUrl: resolvedShop },
      select: {
        shopUrl: true,
        activeMirrorBatchId: true,
        isProductSyncing: true,
        isProductInitialySyning: true,
        shopifyBulkJobCompleted: true,
        syncProgressStage: true,
        productSyncStartedAt: true,
        mirrorUnsafeSince: true,
        updatedAt: true,
      },
    }),
    prisma.syncHistory.findFirst({
      where: {
        shop: resolvedShop,
        operationType: "Product",
        status: "processing",
        stage: {
          in: [
            "SHOPIFY_BULK_RUNNING",
            "MIRROR_DOWNLOAD_STARTED",
            "MIRROR_STAGING",
            "INGESTING_TO_STAGING_BATCH",
            "VALIDATING_BATCH",
            "ACTIVATING_BATCH",
          ],
        },
        updatedAt: { lt: cutoff },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        syncBatchId: true,
        bulkOperationId: true,
        stage: true,
        updatedAt: true,
      },
    }),
  ]);

  if (!isStaleProductSyncStore(store, cutoff) && !latestRunningSync) {
    return { recovered: false };
  }

  const errorMessage = "Product sync timed out before mirror activation. Start product sync again.";
  logStoreMutation("recoverStaleProductSyncStateByShop.updateMany", {
    shop: resolvedShop,
    storeId: store?.shopUrl,
  });
  await prisma.$transaction(async (tx) => {
    if (latestRunningSync) {
      await tx.syncHistory.updateMany({
        where: {
          id: latestRunningSync.id,
          shop: resolvedShop,
          status: "processing",
        },
        data: {
          status: "failed",
          stage: "FAILED",
          errorMessage,
          updatedAt: new Date(),
        },
      });

      if (latestRunningSync.syncBatchId) {
        await tx.mirrorBatch.updateMany({
          where: {
            id: latestRunningSync.syncBatchId,
            shop: resolvedShop,
            status: {
              in: [
                "SYNC_REQUESTED",
                "BULK_OPERATION_STARTED",
                "BULK_OPERATION_COMPLETED",
                "FILE_DOWNLOADING",
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

      await tx.operationFingerprint.updateMany({
        where: {
          shop: resolvedShop,
          operationType: "MIRROR_SYNC",
          resourceType: "sync_history",
          resourceId: latestRunningSync.id,
          status: { in: ["QUEUED", "STARTING_BULK_QUERY", "RUNNING", "INGESTING"] },
        },
        data: {
          status: "FAILED",
          lastError: errorMessage,
          updatedAt: new Date(),
        },
      });
    }

    await tx.store.updateMany({
      where: { shopUrl: resolvedShop },
      data: {
        isProductSyncing: false,
        isProductInitialySyning: false,
        syncProgressStage: "IDLE",
        shopifyBulkJobCompleted: false,
        productSyncStartedAt: null,
        productSyncRecoveryRequired: true,
        mirrorHealthState: store?.activeMirrorBatchId ? "DEGRADED" : "UNSAFE",
        staleReason: "FULL_SYNC_FAILED",
        repairRequired: !store?.activeMirrorBatchId,
        lastSyncErrorSummary: errorMessage,
        updatedAt: new Date(),
      },
    });
  }, {
    maxWait: 10_000,
    timeout: 60_000,
  });

  return { recovered: true };
}

export async function getStoreSyncStateByShop(shop) {
  const resolvedShop = requireShopScope(shop);

  return prisma.store.findUnique({
    where: { shopUrl: resolvedShop },
    select: {
      activeMirrorBatchId: true,
      isProductSyncing: true,
      isProductInitialySyning: true,
      shopifyBulkJobCompleted: true,
      storeTotalProducts: true,
      lastProductSyncAt: true,
      syncProgressStage: true,
    },
  });
}

export async function getStoreCreditFlagsByShop(shop) {
  const resolvedShop = requireShopScope(shop);
  return prisma.store.findUnique({
    where: { shopUrl: resolvedShop },
    select: { shopUrl: true, isCreditAvailable: true, isProductInitialySyning: true },
  });
}

export async function getStoreSyncDetailsByShop(shop) {
  const resolvedShop = requireShopScope(shop);
  return prisma.store.findUnique({
    where: { shopUrl: resolvedShop },
    select: {
      mirrorHealthState: true,
      staleReason: true,
      repairRequired: true,
      mirrorUnsafeSince: true,
      lastFullSyncAt: true,
      lastIncrementalSyncAt: true,
      lastWebhookProcessedAt: true,
      lastReconcileAt: true,
      lastInventoryReconcileAt: true,
      lastCollectionReconcileAt: true,
      lastSyncErrorSummary: true,
      syncProgressStage: true,
      isCollectionSyncing: true,
      lastCollectionSyncAt: true,
      isProductTypeSyncing: true,
      lastProductTypeSyncAt: true,
      isProductInitialySyning: true,
      productInitialSyncProgress: true,
      shopifyBulkJobCompleted: true,
      storeTotalProducts: true,
      isProductSyncing: true,
      lastProductSyncAt: true,
      activeMirrorBatchId: true,
    },
  });
}

export async function getStoreSyncSummaryByShop(shop) {
  const resolvedShop = requireShopScope(shop);
  return prisma.store.findUnique({
    where: { shopUrl: resolvedShop },
    select: {
      syncProgressStage: true,
      isProductInitialySyning: true,
      shopifyBulkJobCompleted: true,
      storeTotalProducts: true,
      isProductSyncing: true,
      lastProductSyncAt: true,
      activeMirrorBatchId: true,
    },
  });
}

export async function getStoreTrackedProductSyncByShop(shop) {
  const resolvedShop = requireShopScope(shop);
  return prisma.store.findUnique({
    where: { shopUrl: resolvedShop },
    select: {
      activeMirrorBatchId: true,
      isProductInitialySyning: true,
      isProductSyncing: true,
      productInitialSyncProgress: true,
      shopifyBulkJobCompleted: true,
      storeTotalProducts: true,
      syncProgressStage: true,
      lastSyncErrorSummary: true,
      lastProductSyncAt: true,
    },
  });
}
