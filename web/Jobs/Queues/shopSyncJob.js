import { Queue } from "bullmq";
import { connection } from "../../config/redis.js";
import { prisma } from "../../config/database.js";
import {
  buildDefaultJobOptions,
  joinSafeJobId,
  mergeJobOptions,
} from "../../utils/jobQueueUtils.js";

const QUEUE_NAME = process.env.SHOP_SYNC_QUEUE || "shop-sync-trigger";

const defaultJobOptions = buildDefaultJobOptions({
  attempts: 6,
  priority: 9,
  backoffDelay: 30_000,
  removeOnComplete: { age: 24 * 3600, count: 500 },
  removeOnFail: { age: 14 * 24 * 3600, count: 2_000 },
});

export const shopSyncQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions,
});

export async function addShopSyncJob(data, options = {}) {
  if (!data?.shop) {
    throw new Error("shop sync job requires shop");
  }
  if (!data?.syncType) {
    throw new Error("shop sync job requires syncType");
  }
  const syncOperationId =
    data.syncOperationId
    || joinSafeJobId("mirror-sync", data.shop, data.syncType, data.reason || "default");

  const fingerprint = `${data.syncType}:${data.reason || "default"}`;
  await prisma.$transaction(async (tx) => {
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
          resourceId: syncOperationId,
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
        resourceId: syncOperationId,
        status: "QUEUED",
        lastError: null,
      },
    });
  });

  const jobId =
    options.jobId || joinSafeJobId("shop-sync", data.shop, syncOperationId);

  return shopSyncQueue.add(
    "shop-sync-trigger",
    {
      ...data,
      syncOperationId,
    },
    mergeJobOptions(defaultJobOptions, {
      ...options,
      jobId,
    }),
  );
}
