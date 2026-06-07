import { Queue } from "bullmq";
import { connection } from "../../config/redis.js";

export const DATA_RETENTION_QUEUE_NAME = "data-retention-purge";
export const DATA_RETENTION_JOB_NAME = "nightly-data-retention-purge";
export const DEFAULT_DATA_RETENTION_PATTERN = "0 0 * * *";

const dataRetentionQueue = new Queue(DATA_RETENTION_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 7 * 24 * 60 * 60, count: 500 },
    removeOnFail: { age: 30 * 24 * 60 * 60, count: 1000 },
  },
});

export async function enqueueDataRetentionPurgeSchedule({
  shop,
  pattern = process.env.DATA_RETENTION_CRON || DEFAULT_DATA_RETENTION_PATTERN,
}) {
  const scopedShop = String(shop || "").trim();
  if (!scopedShop) throw new Error("data retention schedule requires shop");
  return dataRetentionQueue.add(
    DATA_RETENTION_JOB_NAME,
    { shop: scopedShop },
    {
      jobId: `${DATA_RETENTION_JOB_NAME}:${scopedShop}`,
      repeat: { pattern },
    },
  );
}

export async function removeDataRetentionPurgeSchedule({
  shop,
  pattern = process.env.DATA_RETENTION_CRON || DEFAULT_DATA_RETENTION_PATTERN,
}) {
  const scopedShop = String(shop || "").trim();
  if (!scopedShop) return false;
  return dataRetentionQueue.removeRepeatable(
    DATA_RETENTION_JOB_NAME,
    { pattern },
    `${DATA_RETENTION_JOB_NAME}:${scopedShop}`,
  );
}

export default dataRetentionQueue;
