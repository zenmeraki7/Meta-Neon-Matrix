import { Queue } from "bullmq";
import { connection } from "../../config/redis.js";
import {
  buildDefaultJobOptions,
  joinSafeJobId,
  mergeJobOptions,
} from "../../utils/jobQueueUtils.js";

const QUEUE_NAME = process.env.SUBSCRIPTION_BILLING_QUEUE || "subscription-billing";

const defaultJobOptions = buildDefaultJobOptions({
  attempts: 6,
  priority: 7,
  backoffDelay: 15_000,
  removeOnComplete: { age: 7 * 24 * 3600, count: 2000 },
  removeOnFail: { age: 30 * 24 * 3600, count: 10000 },
});

export const subscriptionBillingQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions,
});

export async function addSubscriptionBillingJob(data, options = {}) {
  if (!data?.commandId || !data?.shop) {
    throw new Error("subscription billing job requires commandId and shop");
  }
  return subscriptionBillingQueue.add(
    "subscription-billing",
    data,
    mergeJobOptions(defaultJobOptions, {
      ...options,
      jobId: options.jobId || joinSafeJobId("subscription-billing", data.shop, data.commandId),
    }),
  );
}
