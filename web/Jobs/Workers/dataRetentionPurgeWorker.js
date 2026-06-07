import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import logger from "../../utils/loggerUtils.js";
import { purgeExpiredData } from "../../services/dataRetentionService.js";
import { DATA_RETENTION_QUEUE_NAME } from "../../queues/adapters/dataRetentionQueueAdapter.js";
import {
  acquireOperationLease,
  buildLeaseOwnerId,
  heartbeatOperationLease,
  releaseOperationLease,
} from "../../services/operationLeaseService.js";

const LEASE_NAMESPACE = "DATA_RETENTION_PURGE";
const LEASE_TTL_MS = Math.max(
  60_000,
  Number.parseInt(process.env.DATA_RETENTION_PURGE_LEASE_TTL_MS || `${30 * 60 * 1000}`, 10)
    || 30 * 60 * 1000,
);
const LEASE_HEARTBEAT_MS = Math.max(10_000, Math.floor(LEASE_TTL_MS / 3));

export const dataRetentionPurgeWorker = new Worker(
  DATA_RETENTION_QUEUE_NAME,
  async (job) => {
    const shop = String(job?.data?.shop || "").trim();
    if (!shop) throw new Error("data retention purge requires shop");
    const ownerId = buildLeaseOwnerId("data-retention-purge");
    const lease = await acquireOperationLease({
      shop,
      namespace: LEASE_NAMESPACE,
      resourceId: shop,
      ownerId,
      ttlMs: LEASE_TTL_MS,
    });
    if (!lease?.acquired) {
      logger.warn("Data retention purge skipped because shop purge is already running", {
        worker: "dataRetentionPurgeWorker",
        jobId: job?.id,
        shop,
      });
      return { skipped: true, reason: "shop_purge_already_running", shop };
    }

    const heartbeat = setInterval(() => {
      void heartbeatOperationLease({
        shop,
        namespace: LEASE_NAMESPACE,
        resourceId: shop,
        ownerId,
        ttlMs: LEASE_TTL_MS,
      }).catch((error) => {
        logger.error("Data retention purge lease heartbeat failed", {
          worker: "dataRetentionPurgeWorker",
          jobId: job?.id,
          shop,
          message: error?.message || String(error),
        });
      });
    }, LEASE_HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
      return await purgeExpiredData({ shop });
    } finally {
      clearInterval(heartbeat);
      await releaseOperationLease({
        shop,
        namespace: LEASE_NAMESPACE,
        resourceId: shop,
        ownerId,
      }).catch((error) => {
        logger.error("Data retention purge lease release failed", {
          worker: "dataRetentionPurgeWorker",
          jobId: job?.id,
          shop,
          message: error?.message || String(error),
        });
      });
    }
  },
  {
    connection,
    concurrency: Number(process.env.DATA_RETENTION_PURGE_CONCURRENCY || 1),
  },
);

dataRetentionPurgeWorker.on("completed", (job, result) => {
  logger.info("Data retention purge completed", {
    worker: "dataRetentionPurgeWorker",
    jobId: job?.id,
    shop: job?.data?.shop,
    result,
  });
});

dataRetentionPurgeWorker.on("failed", (job, error) => {
  logger.error("Data retention purge failed", {
    worker: "dataRetentionPurgeWorker",
    jobId: job?.id,
    shop: job?.data?.shop,
    message: error?.message || String(error),
  });
});

dataRetentionPurgeWorker.on("stalled", (jobId) => {
  logger.warn("Data retention purge job stalled", {
    worker: "dataRetentionPurgeWorker",
    jobId,
  });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await dataRetentionPurgeWorker.close();
  } catch (error) {
    logger.error("Data retention purge worker shutdown failed", {
      worker: "dataRetentionPurgeWorker",
      signal,
      message: error?.message || String(error),
    });
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

export default dataRetentionPurgeWorker;
