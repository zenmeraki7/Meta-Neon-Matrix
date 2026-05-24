import { Queue } from "bullmq";
import { connection } from "../../config/redis.js";
import {
  buildDefaultJobOptions,
  mergeJobOptions,
  joinSafeJobId,
} from "../../utils/jobQueueUtils.js";

const QUEUE_NAME = process.env.BULK_EDIT_PIPELINE_QUEUE || "bulk-edit-pipeline";

const defaultJobOptions = buildDefaultJobOptions({
  attempts: 6,
  priority: 6,
  backoffDelay: 15_000,
  removeOnComplete: { age: 7 * 24 * 3600, count: 2_000 },
  removeOnFail: { age: 30 * 24 * 3600, count: 10_000 },
});

export const bulkEditPipelineQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions,
});

export async function enqueueBulkEditTargetFreezeJob(data, options = {}) {
  if (!data?.historyId || !data?.shop || !data?.executionId) {
    throw new Error("target.freeze job requires historyId, shop, and executionId");
  }
  return bulkEditPipelineQueue.add(
    "target.freeze",
    data,
    mergeJobOptions(defaultJobOptions, {
      ...options,
      jobId:
        options.jobId
        || joinSafeJobId(
          "bulk-edit-pipeline-freeze",
          data.historyId,
          data.executionId,
        ),
    }),
  );
}

export async function enqueueBulkEditMutationPlanJob(data, options = {}) {
  if (!data?.historyId || !data?.shop || !data?.executionId) {
    throw new Error("mutation.plan job requires historyId, shop, and executionId");
  }
  return bulkEditPipelineQueue.add(
    "mutation.plan",
    data,
    mergeJobOptions(defaultJobOptions, {
      ...options,
      jobId:
        options.jobId
        || joinSafeJobId(
          "bulk-edit-pipeline-plan",
          data.historyId,
          data.executionId,
        ),
    }),
  );
}

export async function enqueueBulkEditExecuteStageJob(data, options = {}) {
  if (!data?.historyId || !data?.shop || !data?.executionId) {
    throw new Error("bulk.edit.execute job requires historyId, shop, and executionId");
  }
  return bulkEditPipelineQueue.add(
    "bulk.edit.execute",
    data,
    mergeJobOptions(defaultJobOptions, {
      ...options,
      jobId:
        options.jobId
        || joinSafeJobId(
          "bulk-edit-pipeline-execute",
          data.historyId,
          data.executionId,
        ),
    }),
  );
}
