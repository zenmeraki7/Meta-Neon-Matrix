import { Queue } from "bullmq";
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

const APP_INSTALLATION_QUEUE = process.env.APP_INSTALLATION_QUEUE || "app-installation";

export const appInstallationQueue = new Queue(APP_INSTALLATION_QUEUE, {
  connection,
  defaultJobOptions: buildDefaultJobOptions({
    attempts: 5,
    priority: 5,
    backoffDelay: 10_000,
    removeOnComplete: { age: 48 * 3600, count: 500 },
    removeOnFail: { age: 14 * 24 * 3600, count: 2_000 },
  }),
});

export const appUninstallQueue = new Queue("appUninstall", {
  connection,
  defaultJobOptions: buildDefaultJobOptions({
    attempts: 5,
    priority: 5,
    backoffDelay: 10_000,
    removeOnComplete: { age: 48 * 3600, count: 500 },
    removeOnFail: { age: 30 * 24 * 3600, count: 5_000 },
  }),
});

export const bulkEditExecuteQueue = new Queue(
  process.env.BULK_EDIT_EXECUTE_QUEUE || "bulk-edit-execute",
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

export const bulkEditPipelineQueue = new Queue(
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

export const bulkEditResultIngestQueue = new Queue(
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

export const bulkEditResultIngestDlqQueue = new Queue(
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

export const bulkExportQueue = new Queue(process.env.EXPORT_QUEUE || "bulk-export", {
  connection,
  defaultJobOptions: buildDefaultJobOptions({
    attempts: 5,
    priority: 6,
    backoffDelay: 30_000,
    removeOnComplete: { age: 7 * 24 * 3600, count: 2_000 },
    removeOnFail: { age: 30 * 24 * 3600, count: 10_000 },
  }),
});

export const bulkImportEditQueue = new Queue(process.env.IMPORT_EDIT_QUEUE || "importEdit", {
  connection,
  defaultJobOptions: buildDefaultJobOptions({
    attempts: 4,
    priority: 6,
    backoffDelay: 10_000,
    removeOnComplete: { age: 24 * 3600, count: 500 },
    removeOnFail: { age: 14 * 24 * 3600, count: 2_000 },
  }),
});

export const bulkOperationMutationQueue = new Queue(
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

export const bulkOperationQueryQueue = new Queue(
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

export const bulkUndoQueue = new Queue(process.env.UNDO_QUEUE || "bulk-undo", {
  connection,
  defaultJobOptions: buildDefaultJobOptions({
    attempts: 6,
    priority: 7,
    backoffDelay: 10_000,
    removeOnComplete: { age: 48 * 3600, count: 1_000 },
    removeOnFail: { age: 14 * 24 * 3600, count: 5_000 },
  }),
});

export const bulkUndoResultIngestQueue = new Queue(
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

export const productCreateQueue = new Queue(
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

export const productUpdateQueue = new Queue(
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

export const productDeleteQueue = new Queue(
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

export const productSyncClearProductTypesQueue = new Queue(
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

export const productSyncExecuteQueue = new Queue(PRODUCT_SYNC_EXECUTE_QUEUE_NAME, {
  connection,
  defaultJobOptions: PRODUCT_SYNC_JOB_OPTIONS,
});

export const productSyncSchedulerQueue = new Queue(PRODUCT_SYNC_SCHEDULER_QUEUE_NAME, {
  connection,
  defaultJobOptions: PRODUCT_SYNC_JOB_OPTIONS,
});

export const productSyncDlqQueue = new Queue(PRODUCT_SYNC_DLQ_QUEUE_NAME, {
  connection,
  defaultJobOptions: buildDefaultJobOptions({
    attempts: 1,
    backoffDelay: 0,
    removeOnComplete: { age: 7 * 24 * 3600, count: 5_000 },
    removeOnFail: { age: 30 * 24 * 3600, count: 20_000 },
  }),
});

export const scheduledEditQueue = new Queue("scheduled-edit-queue", {
  connection,
  defaultJobOptions: buildDefaultJobOptions({
    attempts: 6,
    priority: 6,
    backoffDelay: 10_000,
    removeOnComplete: { age: 7 * 24 * 3600, count: 2_000 },
    removeOnFail: { age: 30 * 24 * 3600, count: 5_000 },
  }),
});

export const shopSyncQueue = new Queue(SHOP_SYNC_QUEUE_NAME, {
  connection,
  defaultJobOptions: buildDefaultJobOptions({
    attempts: 6,
    priority: 9,
    backoffDelay: 30_000,
    removeOnComplete: { age: 24 * 3600, count: 500 },
    removeOnFail: { age: 14 * 24 * 3600, count: 2_000 },
  }),
});

export const shopSyncDlqQueue = new Queue(SHOP_SYNC_DLQ_QUEUE_NAME, {
  connection,
  defaultJobOptions: buildDefaultJobOptions({
    attempts: 1,
    backoffDelay: 0,
    removeOnComplete: { age: 7 * 24 * 3600, count: 5_000 },
    removeOnFail: { age: 30 * 24 * 3600, count: 20_000 },
  }),
});

export const bulkEditExecuteDlqQueue = new Queue(
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

export const subscriptionBillingQueue = new Queue(
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

export const targetFreezeQueue = new Queue(process.env.TARGET_FREEZE_QUEUE || "target-freeze", {
  connection,
  defaultJobOptions: buildDefaultJobOptions({
    attempts: 5,
    backoffDelay: 5_000,
    removeOnComplete: { age: 7 * 24 * 3600, count: 2_000 },
    removeOnFail: { age: 30 * 24 * 3600, count: 10_000 },
  }),
});

export const bulkEditItemApplyQueue = new Queue(
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

export const bulkEditItemApplyDlqQueue = new Queue(
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

export const bulkEditPipelineDlqQueue = new Queue(
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

export const bulkEditVerificationDlqQueue = new Queue(
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
