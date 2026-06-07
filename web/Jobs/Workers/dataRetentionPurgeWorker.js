import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import logger from "../../utils/loggerUtils.js";
import { purgeExpiredData } from "../../services/dataRetentionService.js";
import { DATA_RETENTION_QUEUE_NAME } from "../../queues/adapters/dataRetentionQueueAdapter.js";

export const dataRetentionPurgeWorker = new Worker(
  DATA_RETENTION_QUEUE_NAME,
  async (job) => {
    const shop = String(job?.data?.shop || "").trim();
    if (!shop) throw new Error("data retention purge requires shop");
    return purgeExpiredData({ shop });
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

export default dataRetentionPurgeWorker;
