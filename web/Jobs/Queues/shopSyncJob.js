import { shopSyncQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";
import { db } from "../../repositories/repositoryDb.js";
import {
  buildDefaultJobOptions,
  joinSafeJobId,
  mergeJobOptions,
} from "../../utils/jobQueueUtils.js";

const defaultJobOptions = buildDefaultJobOptions({
  attempts: 6,
  priority: 9,
  backoffDelay: 5_000,
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 5_000 },
});

export async function addShopSyncJob(data, options = {}) {
  if (!data?.shop) {
    throw new Error("shop sync job requires shop");
  }
  if (!data?.syncType) {
    throw new Error("shop sync job requires syncType");
  }
  let shopId = data?.shopId || null;
  if (!shopId) {
    const store = await db.store.findUnique({
      where: { shopUrl: data.shop },
      select: { id: true },
    });
    shopId = store?.id || null;
  }
  if (!shopId) {
    throw new Error("shop sync job requires resolvable shopId");
  }

  const syncOperationId =
    data.syncOperationId
    || joinSafeJobId("mirror-sync", data.shop, data.syncType, data.reason || "default");

  const fingerprint = `${data.syncType}:${data.reason || "default"}`;
  await db.$transaction(async (tx) => {
    const existing = await tx.operationFingerprint.findUnique({
      where: {
        shop_operationType_fingerprint: {
          shop: data.shop,
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
          shop: data.shop,
          operationType: "MIRROR_SYNC",
          fingerprint,
          resourceType: "sync_request",
          resourceId: null,
          status: "QUEUED",
        },
      });
      return;
    }

    await tx.operationFingerprint.updateMany({
      where: {
        id: existing.id,
        shop: data.shop,
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
    options.jobId || joinSafeJobId("shop-sync", data.shop, syncOperationId);

  return shopSyncQueue.add(
    "shop-sync",
    {
      ...data,
      shopId,
      syncOperationId,
    },
    mergeJobOptions(defaultJobOptions, {
      ...options,
      jobId,
    }),
  );
}
