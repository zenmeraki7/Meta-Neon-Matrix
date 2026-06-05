import { prisma } from "../config/database.js";
import { requireShopScope } from "../utils/shopScope.js";
import { buildEncryptedTokenColumns } from "../utils/tokenCrypto.js";

const PRODUCT_SYNC_STALE_MS = Number(process.env.PRODUCT_SYNC_STALE_MS || 2 * 60 * 60 * 1000);

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

export async function ensureStoreForSession(session) {
  const shop = requireShopScope(session?.shop);
  const tokenColumns = session?.accessToken
    ? buildEncryptedTokenColumns(session.accessToken)
    : {};

  return prisma.store.upsert({
    where: { shopUrl: shop },
    create: {
      shopUrl: shop,
      ...tokenColumns,
      shopEmail: "",
      scope: session?.scope || "",
      isUnInstalled: false,
      unInstalledAt: null,
      installedAt: new Date(),
    },
    update: {
      ...tokenColumns,
      scope: session?.scope || undefined,
      isUnInstalled: false,
      unInstalledAt: null,
      installedAt: new Date(),
    },
    select: {
      shopUrl: true,
      isCreditAvailable: true,
      isProductInitialySyning: true,
    },
  });
}

export async function recoverStaleProductSyncStateByShop(shop) {
  const resolvedShop = requireShopScope(shop);
  const cutoff = new Date(Date.now() - PRODUCT_SYNC_STALE_MS);

  const store = await prisma.store.findUnique({
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
  });

  if (!isStaleProductSyncStore(store, cutoff)) {
    return { recovered: false };
  }

  await prisma.store.update({
    where: { shopUrl: resolvedShop },
    data: {
      isProductSyncing: false,
      isProductInitialySyning: false,
      syncProgressStage: "IDLE",
      shopifyBulkJobCompleted: true,
      productSyncStartedAt: null,
      productSyncRecoveryRequired: true,
      mirrorHealthState: store.activeMirrorBatchId ? "DEGRADED" : "UNSAFE",
      staleReason: "FULL_SYNC_FAILED",
      repairRequired: !store.activeMirrorBatchId,
      lastSyncErrorSummary: "Product sync timed out before completion. Start product sync again.",
      updatedAt: new Date(),
    },
  });

  return { recovered: true };
}

export async function getStoreSyncStateByShop(shop) {
  const resolvedShop = requireShopScope(shop);

  return prisma.store.findUnique({
    where: { shopUrl: resolvedShop },
    select: {
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
      mirrorHealthState: true,
      staleReason: true,
      repairRequired: true,
      mirrorUnsafeSince: true,
      lastSyncErrorSummary: true,
      lastFullSyncAt: true,
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
      isProductInitialySyning: true,
      isProductSyncing: true,
      productInitialSyncProgress: true,
      shopifyBulkJobCompleted: true,
      storeTotalProducts: true,
      syncProgressStage: true,
      lastSyncErrorSummary: true,
    },
  });
}
