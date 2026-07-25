import { bulkExportQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";
import logger from "../../utils/loggerUtils.js";
import {
  buildDefaultJobOptions,
  mergeJobOptions,
} from "../../utils/jobQueueUtils.js";
import {
  PRODUCT_EXPORT_QUEUE_NAME,
  PRODUCT_EXPORT_JOB_NAME,
} from "../../queues/exportQueue.constants.js";

const defaultJobOptions = buildDefaultJobOptions({
  attempts: 5,
  priority: 6,
  backoffDelay: 30_000,
  removeOnComplete: { age: 7 * 24 * 3600, count: 2_000 },
  removeOnFail: { age: 30 * 24 * 3600, count: 10_000 },
});

export async function addbulkExportJob(data, options = {}) {
  if (!data?.exportJobId || !data?.shop || !data?.executionId) {
    throw new Error("bulk export job requires exportJobId, shop, and executionId");
  }

  const job = await bulkExportQueue.add(
    PRODUCT_EXPORT_JOB_NAME,
    data,
    mergeJobOptions(defaultJobOptions, {
      ...options,
      jobId: options.jobId || data.exportJobId,
    }),
  );

  logger.info("Bulk export job enqueued", {
    queue: PRODUCT_EXPORT_QUEUE_NAME,
    queueJobName: PRODUCT_EXPORT_JOB_NAME,
    bullJobId: job.id,
    exportJobId: data.exportJobId,
    shop: data.shop,
    source: data.source || null,
  });

  return job;
}
