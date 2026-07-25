export const PRODUCT_SYNC_SCHEDULER_QUEUE_NAME =
  process.env.PRODUCT_SYNC_SCHEDULER_QUEUE || "product-sync-scheduler";

export const PRODUCT_SYNC_EXECUTE_QUEUE_NAME =
  process.env.PRODUCT_SYNC_EXECUTE_QUEUE || "product-sync-execute";

export const PRODUCT_SYNC_QUEUE_NAME = PRODUCT_SYNC_EXECUTE_QUEUE_NAME;

export const PRODUCT_SYNC_DLQ_QUEUE_NAME =
  process.env.PRODUCT_SYNC_DLQ_QUEUE || "product-sync-dlq";

export const PRODUCT_SYNC_JOB_OPTIONS = {
  attempts: 6,
  backoff: {
    type: "exponential",
    delay: 5000,
  },
  removeOnComplete: {
    age: 86400,
    count: 1000,
  },
  removeOnFail: {
    age: 604800,
    count: 5000,
  },
};
