import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { Services } from "../../services/productService/productFilterService.js";
import { getCurrentBulkOperationStatus } from "../../utils/bulkOperationHelper.js";
import { productSyncQueue } from "../Queues/productSyncQueue.js";
import { prisma } from "../../config/database.js";
import shopify from "../../shopify.js";
import {
  acquireRedisLock,
  releaseRedisLock,
} from "../../utils/redisLockUtils.js";
import dotenv from "dotenv";
dotenv.config();

const service = new Services();

function toIsoHourWindowStart(date = new Date()) {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

function buildProductSyncJobId({ shopUrl, reason, windowStart }) {
  const shopPart = String(shopUrl || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_");
  const reasonPart = String(reason || "scheduled").replace(/[^a-zA-Z0-9_.-]/g, "_");
  const windowPart = String(windowStart || "unspecified").replace(/[^a-zA-Z0-9_.:-]/g, "_");
  return `product-sync:${shopPart}:${reasonPart}:${windowPart}`;
}

async function acquireShopLock(shopUrl, ttlSeconds = 600) {
  const key = `lock:product_sync:${shopUrl}`;
  const lock = await acquireRedisLock({
    connection,
    key,
    ttlMs: ttlSeconds * 1000,
  });
  return lock.acquired ? lock : null;
}

async function releaseShopLock(lock) {
  if (!lock?.acquired) return;
  await releaseRedisLock({
    connection,
    key: lock.key,
    token: lock.token,
  }).catch(() => {});
}

async function syncAllStoresBatched() {
  const batchSize = 20;
  let lastId = null;

  while (true) {
    const stores = await prisma.store.findMany({
      where: {
        isUnInstalled: false,
      },
      select: {
        id: true,
        shopUrl: true,
      },
      orderBy: {
        id: "asc",
      },
      take: batchSize,
      ...(lastId && {
        cursor: { id: lastId },
        skip: 1,
      }),
    });

    if (stores.length === 0) break;

    for (const store of stores) {
      await syncStore(store.shopUrl);
    }

    lastId = stores[stores.length - 1].id;
  }
}

export const productSyncWorker = new Worker(
  "product-sync-queue",
  async (job) => {
    const { shopUrl, type } = job.data;

    try {
      if (type === "auto-sync") {
        await handleAutoSync();
      } else if (type === "priority-sync") {
        await handlePrioritySync();
      } else if (shopUrl) {
        await syncStore(shopUrl);
      } else {
        await syncAllStoresBatched();
      }
    } catch (error) {
      console.error(`❌ Job ${job.id} failed:`, error?.message || error);
      throw error;
    }
  },
  {
    connection,
    concurrency: 3,
    limiter: {
      max: 10,
      duration: 60000,
    },
  },
);

async function handleAutoSync() {
  const now = new Date();
  const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);

  const storesToSync = await prisma.store.findMany({
    where: {
      isUnInstalled: false,
      isProductSyncing: false,
      OR: [
        { lastProductSyncAt: { lt: sixHoursAgo } },
        { lastProductSyncAt: null },
      ],
    },
    select: {
      shopUrl: true,
    },
    orderBy: {
      lastProductSyncAt: "asc",
    },
    take: 10,
  });

  for (let i = 0; i < storesToSync.length; i++) {
    const store = storesToSync[i];
    const delayMs = i * 30_000;
    const windowStart = toIsoHourWindowStart(now);

    await productSyncQueue.add(
      "auto-sync-job",
      { shopUrl: store.shopUrl, syncReason: "auto_sync", windowStart },
      {
        delay: delayMs,
        jobId: buildProductSyncJobId({
          shopUrl: store.shopUrl,
          reason: "auto_sync",
          windowStart,
        }),
      },
    );
  }
}

async function handlePrioritySync() {
  const now = new Date();
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

  const activeStores = await prisma.store.findMany({
    where: {
      isUnInstalled: false,
      isProductSyncing: false,
      lastProductSyncAt: { lt: twoHoursAgo },
      OR: [{ lastActivityAt: { gt: twoHoursAgo } }],
    },
    select: {
      shopUrl: true,
    },
    take: 5,
  });

  for (const store of activeStores) {
    const windowStart = toIsoHourWindowStart(now);
    await productSyncQueue.add(
      "priority-sync-job",
      { shopUrl: store.shopUrl, syncReason: "priority_sync", windowStart },
      {
        priority: 1,
        jobId: buildProductSyncJobId({
          shopUrl: store.shopUrl,
          reason: "priority_sync",
          windowStart,
        }),
      },
    );
  }
}

async function syncStore(shopUrl) {
  const shopLock = await acquireShopLock(shopUrl);
  if (!shopLock?.acquired) {
    console.log(`[worker:sync_locked] shop=${shopUrl} reason=lock_not_acquired`);
    return;
  }

  try {
    const store = await prisma.store.findUnique({
      where: { shopUrl },
      select: {
        isProductSyncing: true,
      },
    });

    if (store?.isProductSyncing) {
      console.log(`[worker:sync_skipped] shop=${shopUrl} reason=already_syncing`);
      return;
    }

    const session = await restoreSession(shopUrl);
    if (!session) {
      console.warn(`⚠️ No offline session found for shop ${shopUrl}, skipping sync`);
      return;
    }

    const currentBulkOperation = await getCurrentBulkOperationStatus(
      session,
      "QUERY",
    );

    if (currentBulkOperation?.status === "RUNNING") {
      console.log(`[worker:sync_skipped] shop=${shopUrl} reason=bulk_op_running bulkOpId=${currentBulkOperation.id}`);
      return;
    }

    console.log(`[worker:sync_start] shop=${shopUrl}`);

    await service.startBulkOperationToFetchProducts({
      session,
      isInitialSync: false,
    });
    console.log(`[worker:sync_triggered] shop=${shopUrl}`);
  } catch (error) {
    console.error(`❌ Error syncing ${shopUrl}:`, error?.message || error);
  } finally {
    await releaseShopLock(shopLock);
  }
}

async function restoreSession(shop) {
  try {
    const sessionId = `offline_${shop}`;
    const session = await shopify.config.sessionStorage.loadSession(sessionId);
    if (!session) return null;
    return session;
  } catch (err) {
    console.error("❌ Error restoring session for", shop, ":", err?.message || err);
    return null;
  }
}

productSyncWorker.on("completed", (job) => {
  console.log(`✅ Job ${job.id} completed`);
});

productSyncWorker.on("failed", (job, err) => {
  console.error(`❌ Job ${job?.id} failed:`, err?.message || err);
});

productSyncWorker.on("error", (err) => {
  console.error("❌ Worker error:", err);
});
