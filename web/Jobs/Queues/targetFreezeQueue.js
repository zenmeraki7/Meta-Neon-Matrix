import { Queue } from "bullmq";
import { connection } from "../../config/redis.js";
import {
  buildBulkTargetFreezeJobId,
  buildDefaultJobOptions,
  mergeJobOptions,
} from "../../utils/jobQueueUtils.js";

const QUEUE_NAME = process.env.TARGET_FREEZE_QUEUE || "target-freeze";

const defaultJobOptions = buildDefaultJobOptions({
  attempts: 5,
  backoffDelay: 5_000,
  removeOnComplete: { age: 7 * 24 * 3600, count: 2_000 },
  removeOnFail: { age: 30 * 24 * 3600, count: 10_000 },
});

export const targetFreezeQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions,
});

export async function enqueueTargetFreezeRequestedJob(payload, options = {}) {
  if (!payload?.shop || !payload?.operationId) {
    throw new Error("target freeze queue payload requires shop and operationId");
  }

  return targetFreezeQueue.add(
    "TARGET_FREEZE_REQUESTED",
    payload,
    mergeJobOptions(defaultJobOptions, {
      ...options,
      jobId: options.jobId || buildBulkTargetFreezeJobId({
        shop: payload.shop,
        operationId: payload.operationId,
      }),
    }),
  );
}
