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
    shopDomain: details.shopDomain || details.shop || null,
    storeId: details.storeId || null,
    syncHistoryId: details.syncHistoryId || null,
    mirrorBatchId: details.mirrorBatchId || null,
    shopifyBulkOperationId: details.shopifyBulkOperationId || null,
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
      shopEmail: command.shopEmail || null,
      ...tokenColumns,
      oauthScopes: command.oauthScopes,
      installationStatus: markInstalled ? "INSTALLED" : "UNINSTALLED",
      legacyIsUninstalled: !markInstalled,
      uninstalledAt: markInstalled ? null : now,
      installedAt: markInstalled ? command.installedAt || now : null,
      lastActivityAt: now,
    }),
    update: withoutUndefined({
      ...(command.shopEmail ? { shopEmail: command.shopEmail } : {}),
      ...tokenColumns,
      ...(command.oauthScopes !== undefined
        ? { oauthScopes: command.oauthScopes ?? "" }
        : {}),
      ...(markInstalled
        ? {
            installationStatus: "INSTALLED",
            legacyIsUninstalled: false,
            uninstalledAt: null,
          }
        : {}),
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
    (store.isProductSyncing === true || store.isProductInitiallySyncing === true || runningStage) &&
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
        currentProductMirrorBatchId: true,
        isProductSyncing: true,
        isProductInitiallySyncing: true,
        hasCompletedShopifyBulkJob: true,
        syncProgressStage: true,
        productSyncStartedAt: true,
        requiresProductSyncRecovery: true,
        mirrorHealthState: true,
        staleReason: true,
        requiresMirrorRepair: true,
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
        mirrorBatchId: true,
        shopifyBulkOperationId: true,
        stage: true,
        updatedAt: true,
      },
    }),
  ]);

  const canRestoreActivatedMirrorPreview = Boolean(
    store?.currentProductMirrorBatchId &&
    store?.isProductSyncing !== true &&
    store?.isProductInitiallySyncing !== true &&
    String(store?.staleReason || "").toUpperCase() === "FULL_SYNC_FAILED" &&
    ["UNSAFE", "REPAIR_REQUIRED"].includes(
      String(store?.mirrorHealthState || "").toUpperCase(),
    ),
  );

  if (canRestoreActivatedMirrorPreview && !latestRunningSync) {
    logStoreMutation("recoverFailedProductSyncActivatedMirror.updateMany", {
      shopDomain: resolvedShop,
      mirrorBatchId: store.currentProductMirrorBatchId,
    });
    await prisma.store.updateMany({
      where: {
        shopUrl: resolvedShop,
        currentProductMirrorBatchId: store.currentProductMirrorBatchId,
        isProductSyncing: false,
        isProductInitiallySyncing: false,
        staleReason: "FULL_SYNC_FAILED",
      },
      data: {
        mirrorHealthState: "DEGRADED",
        requiresMirrorRepair: false,
        mirrorUnsafeSince: null,
        requiresProductSyncRecovery: true,
        updatedAt: new Date(),
      },
    });
    return { recovered: true, restoredActivatedMirrorPreview: true };
  }

  if (!isStaleProductSyncStore(store, cutoff) && !latestRunningSync) {
    return { recovered: false };
  }

  const errorMessage = "Product sync timed out before mirror activation. Start product sync again.";
  logStoreMutation("recoverStaleProductSyncStateByShop.updateMany", {
    shopDomain: resolvedShop,
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

      if (latestRunningSync.mirrorBatchId) {
        await tx.mirrorBatch.updateMany({
          where: {
            id: latestRunningSync.mirrorBatchId,
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
          fingerprintResourceType: "sync_history",
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
        isProductInitiallySyncing: false,
        syncProgressStage: "IDLE",
        hasCompletedShopifyBulkJob: false,
        productSyncStartedAt: null,
        requiresProductSyncRecovery: true,
        mirrorHealthState: store?.currentProductMirrorBatchId ? "DEGRADED" : "UNSAFE",
        staleReason: "FULL_SYNC_FAILED",
        requiresMirrorRepair: !store?.currentProductMirrorBatchId,
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
      currentProductMirrorBatchId: true,
      isProductSyncing: true,
      isProductInitiallySyncing: true,
      hasCompletedShopifyBulkJob: true,
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
    select: { shopUrl: true, isCreditAvailable: true, isProductInitiallySyncing: true },
  });
}

export async function getStoreSyncDetailsByShop(shop) {
  const resolvedShop = requireShopScope(shop);
  return prisma.store.findUnique({
    where: { shopUrl: resolvedShop },
    select: {
      mirrorHealthState: true,
      staleReason: true,
      requiresMirrorRepair: true,
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
      isProductInitiallySyncing: true,
      productInitialSyncProgress: true,
      hasCompletedShopifyBulkJob: true,
      storeTotalProducts: true,
      isProductSyncing: true,
      lastProductSyncAt: true,
      productSyncStartedAt: true,
      currentProductMirrorBatchId: true,
    },
  });
}

export async function getStoreSyncSummaryByShop(shop) {
  const resolvedShop = requireShopScope(shop);
  return prisma.store.findUnique({
    where: { shopUrl: resolvedShop },
    select: {
      syncProgressStage: true,
      isProductInitiallySyncing: true,
      hasCompletedShopifyBulkJob: true,
      storeTotalProducts: true,
      isProductSyncing: true,
      lastProductSyncAt: true,
      productSyncStartedAt: true,
      currentProductMirrorBatchId: true,
    },
  });
}

export async function getStoreTrackedProductSyncByShop(shop) {
  const resolvedShop = requireShopScope(shop);
  return prisma.store.findUnique({
    where: { shopUrl: resolvedShop },
    select: {
      currentProductMirrorBatchId: true,
      isProductInitiallySyncing: true,
      isProductSyncing: true,
      productInitialSyncProgress: true,
      hasCompletedShopifyBulkJob: true,
      storeTotalProducts: true,
      syncProgressStage: true,
      lastSyncErrorSummary: true,
      lastProductSyncAt: true,
      productSyncStartedAt: true,
    },
  });
}
