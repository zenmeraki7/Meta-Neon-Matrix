import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { db } from "../../repositories/repositoryDb.js";
import logger from "../../utils/loggerUtils.js";
import { checkExpiringResultFiles } from "../../services/bulkEdit/bulkSubmissionResultExpiryService.js";
import { addbulkEditResultIngestJob } from "../Queues/bulkEditResultIngestJob.js";

const QUEUE_NAME = "result-file-expiry-check";

export const resultFileExpiryCheckWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const shop = String(job?.data?.shop || "").trim();
    if (!shop) throw new Error("result file expiry check requires shop");
    return checkExpiringResultFiles({
      db,
      shop,
      enqueueResultIngest: addbulkEditResultIngestJob,
      logger,
    });
  },
  { connection, concurrency: 1 },
);

resultFileExpiryCheckWorker.on("completed", (job, result) => {
  logger.info("Result file expiry check completed", {
    worker: "resultFileExpiryCheckWorker",
    jobId: job?.id,
    shop: job?.data?.shop,
    result,
  });
});

resultFileExpiryCheckWorker.on("failed", (job, error) => {
  logger.error("Result file expiry check failed", {
    worker: "resultFileExpiryCheckWorker",
    jobId: job?.id,
    shop: job?.data?.shop,
    message: error?.message || String(error),
  });
});

export default resultFileExpiryCheckWorker;
