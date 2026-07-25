import { productDeleteQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";
import {
  buildDefaultJobOptions,
  buildWebhookJobId,
  mergeJobOptions,
} from "../../utils/jobQueueUtils.js";

const defaultJobOptions = buildDefaultJobOptions({
  attempts: 5,
  priority: 10,
  backoffDelay: 2_000,
  removeOnComplete: { age: 24 * 3600, count: 2_000 },
  removeOnFail: { age: 14 * 24 * 3600, count: 5_000 },
});

export async function addProductDeleteJob(data, options = {}) {
  const jobId =
    options.jobId ||
    buildWebhookJobId({
      topic: "PRODUCTS_DELETE",
      webhookId: data?.webhookId,
      shop: data?.shop,
      entityId: data?.id,
    });

  return productDeleteQueue.add(
    "product-delete",
    data,
    mergeJobOptions(defaultJobOptions, {
      ...options,
      jobId,
    }),
  );
}
