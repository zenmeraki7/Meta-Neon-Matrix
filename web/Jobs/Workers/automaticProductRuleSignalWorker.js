import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import {
  reserveAutomaticProductRuleRunFromSignal,
} from "../../services/automaticProductRuleExecutionService.js";
import {
  AUTOMATIC_PRODUCT_RULE_SIGNAL_QUEUE,
} from "../../queues/adapters/automaticRuleQueueAdapter.js";
import logger from "../../utils/loggerUtils.js";

const automaticProductRuleSignalWorker = new Worker(
  AUTOMATIC_PRODUCT_RULE_SIGNAL_QUEUE,
  async (job) => reserveAutomaticProductRuleRunFromSignal(job.data),
  {
    connection,
    concurrency: 5,
  },
);

automaticProductRuleSignalWorker.on("completed", (job, result) => {
  logger.info("Automatic product rule signal worker completed job", {
    jobId: job.id,
    result,
  });
});

automaticProductRuleSignalWorker.on("failed", (job, error) => {
  logger.error("Automatic product rule signal worker failed job", {
    jobId: job?.id,
    error: error.message,
  });
});

export default automaticProductRuleSignalWorker;
