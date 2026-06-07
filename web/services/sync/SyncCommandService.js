import { Services } from "../productService/productFilterService.js";
import { getCurrentBulkOperationStatus } from "../../utils/bulkOperationHelper.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
import { getProductSyncCacheKeys } from "../../utils/cacheKeyRegistry.js";
import {
  getProductCountByShop,
  getLatestCompletedProductSyncByShop,
} from "../../repositories/syncRepository.js";
import {
  ensureStoreForSession,
  getStoreSyncStateByShop,
} from "../../repositories/storeRepository.js";

const service = new Services();

export async function startProductSync(command = Object.freeze({})) {
  const shop = String(command?.shop || "").trim();
  const accessToken = String(command?.accessToken || "").trim();
  const session = shop && accessToken ? { shop, accessToken } : null;
  const force = Boolean(command?.force);

  if (!shop || !accessToken) {
    const error = new Error("UNAUTHENTICATED");
    error.code = "UNAUTHENTICATED";
    throw error;
  }

  await ensureStoreForSession(session);

  const currentBulkOperation = await getCurrentBulkOperationStatus(session, "QUERY");
  if (currentBulkOperation?.status === "RUNNING") {
    const error = new Error("CONFLICT");
    error.code = "CONFLICT";
    throw error;
  }

  const [store, productCount, latestCompletedSync] = await Promise.all([
    getStoreSyncStateByShop(shop),
    getProductCountByShop(shop),
    getLatestCompletedProductSyncByShop(shop),
  ]);

  const alreadySynced =
    !!store
    && store.isProductSyncing === false
    && store.isProductInitialySyning === false
    && store.shopifyBulkJobCompleted === true
    && productCount > 0;

  if (alreadySynced && !force) {
    return {
      skipped: true,
      forceAllowed: true,
      message: "Products already synced. Skipping new sync.",
      data: {
        productCount,
        storeTotalProducts: store.storeTotalProducts,
        lastProductSyncAt: store.lastProductSyncAt,
        lastCompletedSyncAt: latestCompletedSync?.updatedAt || null,
        lastCompletedRecordCount: latestCompletedSync?.recordCount || null,
        lastCompletedSyncBatchId: latestCompletedSync?.syncBatchId || null,
      },
    };
  }

  const result = await service.startBulkOperationToFetchProducts({
    session,
    isInitialSync: false,
  });

  await Promise.all(getProductSyncCacheKeys(shop).map((key) => clearKeyCaches(key)));

  return {
    skipped: false,
    forced: force,
    success: true,
    message: "Product sync started",
    bulkOperationId: result.bulkOperationId,
    syncHistoryId: result.syncHistoryId,
    syncBatchId: result.syncBatchId,
  };
}
