import { Queue } from "bullmq";
import { connection } from "../../config/redis.js";

const ONE_HOUR = 3600;
const ONE_DAY = 24 * ONE_HOUR;

const automaticProductRuleSchedulerQueue = new Queue("automatic-product-rule-scheduler", {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { age: ONE_HOUR, count: 200 },
    removeOnFail: { age: ONE_DAY, count: 500 },
  },
});

const recurringEditSchedulerQueue = new Queue("recurring-edit-scheduler", {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { age: ONE_HOUR, count: 200 },
    removeOnFail: { age: ONE_DAY, count: 500 },
  },
});

const scheduledExportSchedulerQueue = new Queue("scheduled-export-scheduler", {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { age: ONE_HOUR, count: 200 },
    removeOnFail: { age: ONE_DAY, count: 500 },
  },
});

const operationEnqueueIntentRecoveryQueue = new Queue("operation-enqueue-intent-recovery", {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { age: ONE_HOUR, count: 200 },
    removeOnFail: { age: ONE_DAY, count: 500 },
  },
});

const missedBulkOperationPollingQueue = new Queue("missed-bulk-operation-polling", {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { age: ONE_HOUR, count: 100 },
    removeOnFail: { age: ONE_DAY, count: 500 },
  },
});

const catalogMissedUpdatesPollingQueueByName = new Map();
function getCatalogMissedUpdatesPollingQueue(queueName) {
  const key = String(queueName || "").trim() || "catalog-missed-updates-polling";
  if (!catalogMissedUpdatesPollingQueueByName.has(key)) {
    catalogMissedUpdatesPollingQueueByName.set(
      key,
      new Queue(key, {
        connection,
        defaultJobOptions: {
          attempts: 2,
          backoff: { type: "exponential", delay: 2000 },
          removeOnComplete: { age: ONE_HOUR, count: 100 },
          removeOnFail: { age: ONE_DAY, count: 500 },
        },
      }),
    );
  }
  return catalogMissedUpdatesPollingQueueByName.get(key);
}

const scheduledEditRecoveryQueue = new Queue("scheduled-edit-recovery", {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { age: ONE_HOUR, count: 200 },
    removeOnFail: { age: ONE_DAY, count: 500 },
  },
});

const unresolvedBulkOperationRecoveryQueue = new Queue("unresolved-bulk-operation-recovery", {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { age: ONE_HOUR, count: 200 },
    removeOnFail: { age: ONE_DAY, count: 500 },
  },
});

const stuckBulkMutationRecoveryQueue = new Queue("stuck-bulk-mutation-recovery", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { age: ONE_HOUR, count: 100 },
    removeOnFail: { age: ONE_DAY, count: 500 },
  },
});

const outboxDispatcherSchedulerQueueByName = new Map();
function getOutboxDispatcherSchedulerQueue(queueName) {
  const key = String(queueName || "").trim() || "outbox-dispatcher-scheduler";
  if (!outboxDispatcherSchedulerQueueByName.has(key)) {
    outboxDispatcherSchedulerQueueByName.set(
      key,
      new Queue(key, {
        connection,
        defaultJobOptions: {
          attempts: 2,
          backoff: { type: "exponential", delay: 2000 },
          removeOnComplete: { age: ONE_HOUR, count: 500 },
          removeOnFail: { age: ONE_DAY, count: 1000 },
        },
      }),
    );
  }
  return outboxDispatcherSchedulerQueueByName.get(key);
}

export async function enqueueAutomaticProductRuleSchedulerTick(repeatEveryMs) {
  return automaticProductRuleSchedulerQueue.add(
    "automatic-product-rule-scheduler-tick",
    {},
    { jobId: "automatic-product-rule-scheduler-tick", repeat: { every: repeatEveryMs } },
  );
}

export async function enqueueRecurringEditSchedulerTick(repeatEveryMs) {
  return recurringEditSchedulerQueue.add(
    "recurring-edit-scheduler-tick",
    {},
    { jobId: "recurring-edit-scheduler-tick", repeat: { every: repeatEveryMs } },
  );
}

export async function enqueueScheduledExportSchedulerTick(repeatEveryMs) {
  return scheduledExportSchedulerQueue.add(
    "scheduled-export-scheduler-tick",
    {},
    { jobId: "scheduled-export-scheduler-tick", repeat: { every: repeatEveryMs } },
  );
}

export async function enqueueOperationEnqueueIntentRecoveryTick(repeatEveryMs) {
  return operationEnqueueIntentRecoveryQueue.add(
    "operation-enqueue-intent-recovery-tick",
    {},
    { jobId: "operation-enqueue-intent-recovery-tick", repeat: { every: repeatEveryMs } },
  );
}

export async function enqueueMissedBulkOperationPollingTick(repeatEveryMs) {
  return missedBulkOperationPollingQueue.add(
    "poll-missed-bulk-operations",
    {},
    { jobId: "poll-missed-bulk-operations", repeat: { every: repeatEveryMs } },
  );
}

export async function enqueueMissedBulkOperationPollingJob() {
  return missedBulkOperationPollingQueue.add(
    "poll-missed-bulk-operations",
    {},
    { jobId: "poll-missed-bulk-operations" },
  );
}

export async function enqueueCatalogMissedUpdatesPollingTick({ queueName, repeatEveryMs }) {
  const queue = getCatalogMissedUpdatesPollingQueue(queueName);
  return queue.add(
    "poll-catalog-missed-updates",
    {},
    { jobId: "poll-catalog-missed-updates", repeat: { every: repeatEveryMs } },
  );
}

export async function enqueueScheduledEditRecoveryTick(repeatEveryMs) {
  return scheduledEditRecoveryQueue.add(
    "scheduled-edit-recovery-tick",
    {},
    { jobId: "scheduled-edit-recovery-tick", repeat: { every: repeatEveryMs } },
  );
}

export async function enqueueUnresolvedBulkOperationRecoveryTick(repeatEveryMs) {
  return unresolvedBulkOperationRecoveryQueue.add(
    "unresolved-bulk-operation-recovery-tick",
    {},
    { jobId: "unresolved-bulk-operation-recovery-tick", repeat: { every: repeatEveryMs } },
  );
}

export async function enqueueStuckBulkMutationRecoveryTick(repeatEveryMs) {
  return stuckBulkMutationRecoveryQueue.add(
    "recover-stuck-bulk-mutations",
    {},
    { jobId: "recover-stuck-bulk-mutations", repeat: { every: repeatEveryMs } },
  );
}

export async function enqueueStuckBulkMutationRecoveryJob() {
  return stuckBulkMutationRecoveryQueue.add(
    "recover-stuck-bulk-mutations",
    {},
    { jobId: "recover-stuck-bulk-mutations" },
  );
}

export async function enqueueOutboxDispatcherSchedulerTick({ queueName, repeatEveryMs }) {
  const queue = getOutboxDispatcherSchedulerQueue(queueName);
  return queue.add(
    "outbox-dispatcher-scheduler-tick",
    {},
    { jobId: "outbox-dispatcher-scheduler-tick", repeat: { every: repeatEveryMs } },
  );
}
