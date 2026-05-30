import { Queue } from "bullmq";
import { connection } from "../../config/redis.js";
import {
  buildBullSafeJobId,
  buildDefaultJobOptions,
  mergeJobOptions,
} from "../../utils/jobQueueUtils.js";

const QUEUE_NAME = "appUninstall";

const defaultJobOptions = buildDefaultJobOptions({
  attempts: 5,
  priority: 5,
  backoffDelay: 10_000,
  removeOnComplete: { age: 48 * 3600, count: 500 },
  removeOnFail: { age: 30 * 24 * 3600, count: 5_000 },
});

export const appUninstallQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions,
});

export async function addAppUninstallJob(data, options = {}) {
  const jobId = options.jobId || buildBullSafeJobId("app-uninstall", data?.shop);

  return appUninstallQueue.add(
    "app-uninstall",
    data,
    mergeJobOptions(defaultJobOptions, {
      ...options,
      jobId,
    }),
  );
}