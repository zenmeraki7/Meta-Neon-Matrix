import { getCache, setCache } from "../utils/cacheUtils.js";
import {
  getStoreCreditFlagsByShop,
} from "../repositories/storeRepository.js";
import {
  countCompletedBulkEditsByShop,
  countCompletedProductSyncsByShop,
} from "../repositories/syncRepository.js";

const STORE_ACCESS_CACHE_TTL_SECONDS = 300;
const STORE_TIMEZONE_CACHE_TTL_SECONDS = 24 * 60 * 60;

async function resolveShopTimezoneCached({ shop, readShopTimezone }) {
  const timezoneCacheKey = `${shop}:storeTimezone`;
  const cachedTimezone = await getCache(timezoneCacheKey);
  if (cachedTimezone) {
    return String(cachedTimezone);
  }
  const timezone = await readShopTimezone();
  await setCache(timezoneCacheKey, timezone, STORE_TIMEZONE_CACHE_TTL_SECONDS);
  return timezone;
}

export async function getStoreAccess({
  shop,
  ensureStore,
  readShopTimezone,
}) {
  const normalizedShop = String(shop || "").trim();
  if (!normalizedShop) {
    const error = new Error("UNAUTHENTICATED");
    error.code = "UNAUTHENTICATED";
    throw error;
  }

  if (typeof ensureStore !== "function") {
    const error = new Error("Store access ensureStore dependency is required");
    error.code = "STORE_ACCESS_DEPENDENCY_REQUIRED";
    throw error;
  }

  if (typeof readShopTimezone !== "function") {
    const error = new Error("Store access timezone dependency is required");
    error.code = "STORE_ACCESS_DEPENDENCY_REQUIRED";
    throw error;
  }

  const cacheKey = `${normalizedShop}:storeDetails`;
  const cached = await getCache(cacheKey);
  if (cached) {
    return cached;
  }

  const store =
    (await getStoreCreditFlagsByShop(normalizedShop)) || (await ensureStore());

  const [totalbulkEditCount, totalSyncCount, shopTimezone] = await Promise.all([
    countCompletedBulkEditsByShop(normalizedShop),
    countCompletedProductSyncsByShop(normalizedShop),
    resolveShopTimezoneCached({ shop: normalizedShop, readShopTimezone }),
  ]);

  const storeAccess = {
    shopUrl: store.shopUrl,
    shopTimezone,
    totalbulkEditCount,
    totalSyncCount,
    isProductInitialySyning: store.isProductInitialySyning,
    isCreditAvailable: store.isCreditAvailable || false,
  };

  await setCache(cacheKey, storeAccess, STORE_ACCESS_CACHE_TTL_SECONDS);
  return storeAccess;
}
