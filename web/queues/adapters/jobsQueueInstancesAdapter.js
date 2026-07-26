import { connection } from "../../config/redis.js";
import { buildDefaultJobOptions } from "../../utils/jobQueueUtils.js";
import {
  SHOP_SYNC_DLQ_QUEUE_NAME,
  SHOP_SYNC_QUEUE_NAME,
} from "../shopSyncQueue.constants.js";
import {
  PRODUCT_SYNC_DLQ_QUEUE_NAME,
  PRODUCT_SYNC_EXECUTE_QUEUE_NAME,
  PRODUCT_SYNC_JOB_OPTIONS,
  PRODUCT_SYNC_SCHEDULER_QUEUE_NAME,
} from "../productSyncQueue.constants.js";
import { PRODUCT_EXPORT_QUEUE_NAME } from "../exportQueue.constants.js";
import { QUEUE_NAMES } from "../queueNames.js";

let QueueClass = null;

try {
  const bullmq = await import("bullmq");
  QueueClass = bullmq.Queue;
} catch {
  QueueClass = class DummyQueue {
    constructor(name) {
      this.name = name;
    }
    async add() {
      return { id: "dummy_job_id" };
    }
  };
}

function createSafeQueue(name, options) {
  return new QueueClass(name, options);
}

const APP_INSTALLATION_QUEUE = process.env.APP_INSTALLATION_QUEUE || "app-installation";

export const appInstallationQueue = createSafeQueue(APP_INSTALLATION_QUEUE, {
  connection,
  defaultJobOptions: buildDefaultJobOptions({
    attempts: 5,
    priority: 5,
    backoffDelay: 10_000,
    removeOnComplete: { age: 48 * 3600, count: 500 },
    removeOnFail: { age: 14 * 24 * 3600, count: 2_000 },
  }),
});

export const appUninstallQueue = createSafeQueue("appUninstall", {
  connection,
  defaultJobOptions: buildDefaultJobOptions({
    attempts: 5,
    priority: 5,
    backoffDelay: 10_000,
    removeOnComplete: { age: 48 * 3600, count: 500 },
    removeOnFail: { age: 30 * 24 * 3600, count: 5_000 },
  }),
});

export const bulkEditExecuteQueue = createSafeQueue(
  QUEUE_NAMES.BULK_EDIT_EXECUTE,
  {
    connection,
    defaultJobOptions: buildDefaultJobOptions({
      attempts: 8,
      priority: 7,
      backoffDelay: 30_000,
      removeOnComplete: { age: 7 * 24 * 3600, count: 2_000 },
      removeOnFail: { age: 30 * 24 * 3600, count: 10_000 },
    }),
  },
);

export const bulkEditPipelineQueue = createSafeQueue(
  process.env.BULK_EDIT_PIPELINE_QUEUE || "bulk-edit-pipeline",
  {
    connection,
    defaultJobOptions: buildDefaultJobOptions({
      attempts: 6,
      priority: 6,
      backoffDelay: 15_000,
      removeOnComplete: { age: 7 * 24 * 3600, count: 2_000 },
      removeOnFail: { age: 30 * 24 * 3600, count: 10_000 },
    }),
  },
);

export const bulkEditResultIngestQueue = createSafeQueue(
  process.env.BULK_EDIT_RESULT_INGEST_QUEUE || "bulk-edit-result-ingest",
  {
    connection,
    defaultJobOptions: buildDefaultJobOptions({
      attempts: 8,
      priority: 8,
      backoffDelay: 5_000,
      removeOnComplete: { age: 48 * 3600, count: 2_000 },
      removeOnFail: { age: 14 * 24 * 3600, count: 10_000 },
    }),
  },
);

export const bulkEditResultIngestDlqQueue = createSafeQueue(
  process.env.BULK_EDIT_RESULT_INGEST_DLQ_QUEUE || "bulk-edit-result-ingest-dlq",
  {
    connection,
    defaultJobOptions: buildDefaultJobOptions({
      attempts: 1,
      backoffDelay: 0,
      removeOnComplete: { age: 7 * 24 * 3600, count: 5_000 },
      removeOnFail: { age: 30 * 24 * 3600, count: 20_000 },
    }),
  },
);

export const bulkExportQueue = createSafeQueue(PRODUCT_EXPORT_QUEUE_NAME, {
  connection,
  defaultJobOptions: buildDefaultJobOptions({
    attempts: 5,
    priority: 6,
    backoffDelay: 30_000,
    removeOnComplete: { age: 7 * 24 * 3600, count: 2_000 },
    removeOnFail: { age: 30 * 24 * 3600, count: 10_000 },
  }),
});

export const bulkImportEditQueue = createSafeQueue(QUEUE_NAMES.CSV_IMPORT_PREPARE, {
  connection,
  defaultJobOptions: buildDefaultJobOptions({
    attempts: 4,
    priority: 6,
    backoffDelay: 10_000,
    removeOnComplete: { age: 24 * 3600, count: 500 },
    removeOnFail: { age: 14 * 24 * 3600, count: 2_000 },
  }),
});

export const bulkOperationMutationQueue = createSafeQueue(
  process.env.BULK_OPERATION_MUTATION_QUEUE || "bulk-operation-mutation",
  {
    connection,
    defaultJobOptions: buildDefaultJobOptions({
      attempts: 8,
      priority: 8,
      backoffDelay: 5_000,
      removeOnComplete: { age: 48 * 3600, count: 2_000 },
      removeOnFail: { age: 14 * 24 * 3600, count: 10_000 },
    }),
  },
);

export const bulkOperationQueryQueue = createSafeQueue(
  process.env.BULK_OPERATION_QUERY_QUEUE || "bulk-operation-query",
  {
    connection,
    defaultJobOptions: buildDefaultJobOptions({
      attempts: 8,
      priority: 8,
      backoffDelay: 5_000,
      removeOnComplete: { age: 48 * 3600, count: 2_000 },
      removeOnFail: { age: 14 * 24 * 3600, count: 10_000 },
    }),
  },
);

export const bulkUndoQueue = createSafeQueue(process.env.UNDO_QUEUE || "bulk-undo", {
  connection,
  defaultJobOptions: buildDefaultJobOptions({
    attempts: 6,
    priority: 7,
    backoffDelay: 10_000,
    removeOnComplete: { age: 48 * 3600, count: 1_000 },
    removeOnFail: { age: 14 * 24 * 3600, count: 5_000 },
  }),
});

export const bulkUndoResultIngestQueue = createSafeQueue(
  process.env.BULK_UNDO_RESULT_INGEST_QUEUE || "bulk-undo-result-ingest",
  {
    connection,
    defaultJobOptions: buildDefaultJobOptions({
      attempts: 8,
      priority: 8,
      backoffDelay: 10_000,
      removeOnComplete: { age: 48 * 3600, count: 2_000 },
      removeOnFail: { age: 14 * 24 * 3600, count: 10_000 },
    }),
  },
);

export const productCreateQueue = createSafeQueue(
  process.env.NODE_ENV === "production" ? "product-create" : "product-create-job-dev",
  {
    connection,
    defaultJobOptions: buildDefaultJobOptions({
      attempts: 5,
      priority: 10,
      backoffDelay: 2_000,
      removeOnComplete: { age: 24 * 3600, count: 2_000 },
      removeOnFail: { age: 14 * 24 * 3600, count: 5_000 },
    }),
  },
);

export const productUpdateQueue = createSafeQueue(
  process.env.NODE_ENV === "production" ? "product-update" : "product-update-job-dev",
  {
    connection,
    defaultJobOptions: buildDefaultJobOptions({
      attempts: 5,
      priority: 10,
      backoffDelay: 2_000,
      removeOnComplete: { age: 24 * 3600, count: 2_000 },
      removeOnFail: { age: 14 * 24 * 3600, count: 5_000 },
    }),
  },
);

export const productDeleteQueue = createSafeQueue(
  process.env.NODE_ENV === "production" ? "product-delete" : "product-delete-job-dev",
  {
    connection,
    defaultJobOptions: buildDefaultJobOptions({
      attempts: 5,
      priority: 10,
      backoffDelay: 2_000,
      removeOnComplete: { age: 24 * 3600, count: 2_000 },
      removeOnFail: { age: 14 * 24 * 3600, count: 5_000 },
    }),
  },
);

export const productSyncClearProductTypesQueue = createSafeQueue(
  process.env.PRODUCT_SYNC_CLEAR_PRODUCT_TYPES_QUEUE || "product-sync-clear-product-types",
  {
    connection,
    defaultJobOptions: buildDefaultJobOptions({
      attempts: 6,
      priority: 6,
      backoffDelay: 15_000,
      removeOnComplete: { age: 7 * 24 * 3600, count: 2_000 },
      removeOnFail: { age: 30 * 24 * 3600, count: 10_000 },
    }),
  },
);

export const productSyncExecuteQueue = createSafeQueue(PRODUCT_SYNC_EXECUTE_QUEUE_NAME, {
  connection,
  defaultJobOptions: PRODUCT_SYNC_JOB_OPTIONS,
});

export const productSyncSchedulerQueue = createSafeQueue(PRODUCT_SYNC_SCHEDULER_QUEUE_NAME, {
  connection,
  defaultJobOptions: PRODUCT_SYNC_JOB_OPTIONS,
});

export const productSyncDlqQueue = createSafeQueue(PRODUCT_SYNC_DLQ_QUEUE_NAME, {
  connection,
  defaultJobOptions: buildDefaultJobOptions({
    attempts: 1,
    backoffDelay: 0,
    removeOnComplete: { age: 7 * 24 * 3600, count: 5_000 },
    removeOnFail: { age: 30 * 24 * 3600, count: 20_000 },
  }),
});

export const scheduledEditQueue = createSafeQueue("scheduled-edit-queue", {
  connection,
  defaultJobOptions: buildDefaultJobOptions({
    attempts: 6,
    priority: 6,
    backoffDelay: 10_000,
    removeOnComplete: { age: 7 * 24 * 3600, count: 2_000 },
    removeOnFail: { age: 30 * 24 * 3600, count: 5_000 },
  }),
});

export const shopSyncQueue = createSafeQueue(SHOP_SYNC_QUEUE_NAME, {
  connection,
  defaultJobOptions: buildDefaultJobOptions({
    attempts: 6,
    priority: 9,
    backoffDelay: 30_000,
    removeOnComplete: { age: 24 * 3600, count: 500 },
    removeOnFail: { age: 14 * 24 * 3600, count: 2_000 },
  }),
});

export const shopSyncDlqQueue = createSafeQueue(SHOP_SYNC_DLQ_QUEUE_NAME, {
  connection,
  defaultJobOptions: buildDefaultJobOptions({
    attempts: 1,
    backoffDelay: 0,
    removeOnComplete: { age: 7 * 24 * 3600, count: 5_000 },
    removeOnFail: { age: 30 * 24 * 3600, count: 20_000 },
  }),
});

export const bulkEditExecuteDlqQueue = createSafeQueue(
  process.env.BULK_EDIT_EXECUTE_DLQ_QUEUE || "bulk-edit-execute-dlq",
  {
    connection,
    defaultJobOptions: buildDefaultJobOptions({
      attempts: 1,
      backoffDelay: 0,
      removeOnComplete: { age: 7 * 24 * 3600, count: 5_000 },
      removeOnFail: { age: 30 * 24 * 3600, count: 20_000 },
    }),
  },
);

export const subscriptionBillingQueue = createSafeQueue(
  process.env.SUBSCRIPTION_BILLING_QUEUE || "subscription-billing",
  {
    connection,
    defaultJobOptions: buildDefaultJobOptions({
      attempts: 6,
      priority: 7,
      backoffDelay: 15_000,
      removeOnComplete: { age: 7 * 24 * 3600, count: 2000 },
      removeOnFail: { age: 30 * 24 * 3600, count: 10000 },
    }),
  },
);

export const targetFreezeQueue = createSafeQueue(process.env.TARGET_FREEZE_QUEUE || "target-freeze", {
  connection,
  defaultJobOptions: buildDefaultJobOptions({
    attempts: 5,
    backoffDelay: 5_000,
    removeOnComplete: { age: 7 * 24 * 3600, count: 2_000 },
    removeOnFail: { age: 30 * 24 * 3600, count: 10_000 },
  }),
});

export const bulkEditItemApplyQueue = createSafeQueue(
  process.env.BULK_EDIT_ITEM_APPLY_QUEUE || "bulk-edit-item-apply",
  {
    connection,
    defaultJobOptions: buildDefaultJobOptions({
      attempts: 5,
      priority: 7,
      backoffDelay: 2_000,
      removeOnComplete: { age: 24 * 3600, count: 2_000 },
      removeOnFail: { age: 14 * 24 * 3600, count: 10_000 },
    }),
  },
);

export const bulkEditItemApplyDlqQueue = createSafeQueue(
  process.env.BULK_EDIT_ITEM_APPLY_DLQ_QUEUE || "bulk-edit-item-apply-dlq",
  {
    connection,
    defaultJobOptions: buildDefaultJobOptions({
      attempts: 1,
      backoffDelay: 0,
      removeOnComplete: { age: 7 * 24 * 3600, count: 5_000 },
      removeOnFail: { age: 30 * 24 * 3600, count: 20_000 },
    }),
  },
);

export const bulkEditPipelineDlqQueue = createSafeQueue(
  process.env.BULK_EDIT_PIPELINE_DLQ_QUEUE || "bulk-edit-pipeline-dlq",
  {
    connection,
    defaultJobOptions: buildDefaultJobOptions({
      attempts: 1,
      backoffDelay: 0,
      removeOnComplete: { age: 7 * 24 * 3600, count: 5_000 },
      removeOnFail: { age: 30 * 24 * 3600, count: 20_000 },
    }),
  },
);

export const bulkEditVerificationDlqQueue = createSafeQueue(
  process.env.BULK_EDIT_VERIFICATION_DLQ_QUEUE || "bulk-edit-verification-dlq",
  {
    connection,
    defaultJobOptions: buildDefaultJobOptions({
      attempts: 1,
      backoffDelay: 0,
      removeOnComplete: { age: 7 * 24 * 3600, count: 5_000 },
      removeOnFail: { age: 30 * 24 * 3600, count: 20_000 },
    }),
  },
);
