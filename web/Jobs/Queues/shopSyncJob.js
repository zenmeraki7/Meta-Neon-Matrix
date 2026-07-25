import { shopSyncQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";
import { db } from "../../repositories/repositoryDb.js";
import {
  buildDefaultJobOptions,
  joinSafeJobId,
  mergeJobOptions,
} from "../../utils/jobQueueUtils.js";
import { requireShopDomain, requireStoreId } from "../../utils/identity.js";

/** @typedef {import("../../types/identity.js").StoreId} StoreId */
/** @typedef {import("../../types/identity.js").ShopDomain} ShopDomain */
/**
 * @typedef {object} ShopSyncJobData
 * @property {ShopDomain} shopDomain
 * @property {StoreId=} storeId
 * @property {string} syncType
 * @property {string=} reason
 * @property {string=} syncOperationId
 */

const defaultJobOptions = buildDefaultJobOptions({
  attempts: 6,
  priority: 9,
  backoffDelay: 5_000,
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 5_000 },
});

/** @param {ShopSyncJobData} data */
export async function addShopSyncJob(data, options = {}) {
  if (
    Object.hasOwn(data || {}, "shop")
    || Object.hasOwn(data || {}, "shopUrl")
    || Object.hasOwn(data || {}, "domain")
  ) {
    throw new Error("LEGACY_QUEUE_TENANT_KEYS_REJECTED");
  }
  if (!data?.shopDomain) {
    throw new Error("shop sync job requires shopDomain");
  }
  if (!data?.syncType) {
    throw new Error("shop sync job requires syncType");
  }
  const shopDomain = requireShopDomain(data.shopDomain);
  let storeId = data?.storeId ? requireStoreId(data.storeId) : null;
  if (!storeId) {
    const store = await db.store.findUnique({
      where: { shopUrl: shopDomain },
      select: { id: true },
    });
    storeId = store?.id ? requireStoreId(store.id) : null;
  }
  if (!storeId) {
    throw new Error("shop sync job requires resolvable storeId");
  }

  const syncOperationId =
    data.syncOperationId
    || joinSafeJobId("mirror-sync", shopDomain, data.syncType, data.reason || "default");

  const fingerprint = `${data.syncType}:${data.reason || "default"}`;
  await db.$transaction(async (tx) => {
    const existing = await tx.operationFingerprint.findUnique({
      where: {
        shop_operationType_fingerprint: {
          shop: shopDomain,
          operationType: "MIRROR_SYNC",
          fingerprint,
        },
      },
      select: {
        id: true,
        status: true,
      },
    });

    if (!existing) {
      await tx.operationFingerprint.create({
        data: {
          id: syncOperationId,
          shop: shopDomain,
          operationType: "MIRROR_SYNC",
          fingerprint,
          fingerprintResourceType: "sync_request",
          resourceId: null,
          status: "QUEUED",
        },
      });
      return;
    }

    await tx.operationFingerprint.updateMany({
      where: {
        id: existing.id,
        shop: shopDomain,
        operationType: "MIRROR_SYNC",
        status: { in: ["QUEUED", "FAILED", "RETRYABLE_FAILURE", "COMPLETED", "CANCELLED"] },
      },
      data: {
        resourceId: null,
        status: "QUEUED",
        lastError: null,
      },
    });
  });

  const jobId =
    options.jobId || joinSafeJobId("shop-sync", shopDomain, syncOperationId);

  return shopSyncQueue.add(
    "shop-sync",
    {
      ...data,
      shopDomain,
      storeId,
      syncOperationId,
    },
    mergeJobOptions(defaultJobOptions, {
      ...options,
      jobId,
    }),
  );
}
