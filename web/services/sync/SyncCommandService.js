import { Services } from "../productService/productFilterService.js";
import { getCurrentBulkOperationStatus } from "../../utils/bulkOperationHelper.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
import {
  getProductCountByShop,
  getLatestCompletedProductSyncByShop,
} from "../../repositories/syncRepository.js";
import { getStoreSyncStateByShop } from "../../repositories/storeRepository.js";

const service = new Services();

export async function startProductSync(command = Object.freeze({})) {
  const session = command?.session || null;
  const force = Boolean(command?.force);
  const shop = String(session?.shop || "").trim();

  if (!shop) {
    const error = new Error("UNAUTHENTICATED");
    error.code = "UNAUTHENTICATED";
    throw error;
  }

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

  await clearKeyCaches(`${shop}:sync_details`);

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
