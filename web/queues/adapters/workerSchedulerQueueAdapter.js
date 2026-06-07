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

const resultFileExpiryCheckQueue = new Queue("result-file-expiry-check", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: ONE_DAY, count: 200 },
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

export async function enqueueAutomaticProductRuleSchedulerTick({ shop, repeatEveryMs }) {
  const scopedShop = String(shop || "").trim();
  if (!scopedShop) {
    throw new Error("automatic product rule scheduler tick requires shop");
  }
  return automaticProductRuleSchedulerQueue.add(
    "automatic-product-rule-scheduler-tick",
    { shop: scopedShop },
    {
      jobId: `automatic-product-rule-scheduler-tick:${scopedShop}`,
      repeat: { every: repeatEveryMs },
    },
  );
}

export async function enqueueRecurringEditSchedulerTick({ shop, repeatEveryMs }) {
  if (!shop) {
    throw new Error("recurring edit scheduler tick requires shop");
  }
  return recurringEditSchedulerQueue.add(
    "recurring-edit-scheduler-tick",
    { shop },
    { jobId: `recurring-edit-scheduler-tick:${shop}`, repeat: { every: repeatEveryMs } },
  );
}

export async function enqueueScheduledExportSchedulerTick({ shop, repeatEveryMs }) {
  if (!shop) {
    throw new Error("scheduled export scheduler tick requires shop");
  }
  return scheduledExportSchedulerQueue.add(
    "scheduled-export-scheduler-tick",
    { shop },
    { jobId: `scheduled-export-scheduler-tick:${shop}`, repeat: { every: repeatEveryMs } },
  );
}

export async function enqueueOperationEnqueueIntentRecoveryTick({ shop, repeatEveryMs }) {
  if (!shop) {
    throw new Error("operation enqueue intent recovery tick requires shop");
  }
  return operationEnqueueIntentRecoveryQueue.add(
    "operation-enqueue-intent-recovery-tick",
    { shop },
    { jobId: `operation-enqueue-intent-recovery-tick:${shop}`, repeat: { every: repeatEveryMs } },
  );
}

export async function enqueueMissedBulkOperationPollingTick({ shop, repeatEveryMs }) {
  if (!shop) {
    throw new Error("missed bulk operation polling tick requires shop");
  }
  return missedBulkOperationPollingQueue.add(
    "poll-missed-bulk-operations",
    { shop },
    { jobId: `poll-missed-bulk-operations:${shop}`, repeat: { every: repeatEveryMs } },
  );
}

export async function enqueueMissedBulkOperationPollingJob({ shop }) {
  if (!shop) {
    throw new Error("missed bulk operation polling job requires shop");
  }
  return missedBulkOperationPollingQueue.add(
    "poll-missed-bulk-operations",
    { shop },
    { jobId: `poll-missed-bulk-operations:${shop}` },
  );
}

export async function enqueueCatalogMissedUpdatesPollingTick({ queueName, shop, repeatEveryMs }) {
  if (!shop) {
    throw new Error("catalog missed updates polling tick requires shop");
  }
  const queue = getCatalogMissedUpdatesPollingQueue(queueName);
  return queue.add(
    "poll-catalog-missed-updates",
    { shop },
    { jobId: `poll-catalog-missed-updates:${shop}`, repeat: { every: repeatEveryMs } },
  );
}

export async function enqueueScheduledEditRecoveryTick({ shop, repeatEveryMs }) {
  if (!shop) {
    throw new Error("scheduled edit recovery tick requires shop");
  }
  return scheduledEditRecoveryQueue.add(
    "scheduled-edit-recovery-tick",
    { shop },
    { jobId: `scheduled-edit-recovery-tick:${shop}`, repeat: { every: repeatEveryMs } },
  );
}

export async function enqueueUnresolvedBulkOperationRecoveryTick({ shop, repeatEveryMs }) {
  if (!shop) {
    throw new Error("unresolved bulk operation recovery tick requires shop");
  }
  return unresolvedBulkOperationRecoveryQueue.add(
    "unresolved-bulk-operation-recovery-tick",
    { shop },
    { jobId: `unresolved-bulk-operation-recovery-tick:${shop}`, repeat: { every: repeatEveryMs } },
  );
}

export async function enqueueResultFileExpiryCheckTick({ shop, repeatEveryMs }) {
  if (!shop) {
    throw new Error("result file expiry check tick requires shop");
  }
  return resultFileExpiryCheckQueue.add(
    "result-file-expiry-check-tick",
    { shop },
    { jobId: `result-file-expiry-check-tick:${shop}`, repeat: { every: repeatEveryMs } },
  );
}

export async function enqueueStuckBulkMutationRecoveryTick({ shop, repeatEveryMs }) {
  if (!shop) {
    throw new Error("stuck bulk mutation recovery tick requires shop");
  }
  return stuckBulkMutationRecoveryQueue.add(
    "recover-stuck-bulk-mutations",
    { shop },
    { jobId: `recover-stuck-bulk-mutations:${shop}`, repeat: { every: repeatEveryMs } },
  );
}

export async function enqueueStuckBulkMutationRecoveryJob({ shop }) {
  if (!shop) {
    throw new Error("stuck bulk mutation recovery job requires shop");
  }
  return stuckBulkMutationRecoveryQueue.add(
    "recover-stuck-bulk-mutations",
    { shop },
    { jobId: `recover-stuck-bulk-mutations:${shop}` },
  );
}

export async function enqueueOutboxDispatcherSchedulerTick({ queueName, shop, repeatEveryMs }) {
  if (!shop) {
    throw new Error("outbox dispatcher scheduler tick requires shop");
  }
  const queue = getOutboxDispatcherSchedulerQueue(queueName);
  return queue.add(
    "outbox-dispatcher-scheduler-tick",
    { shop },
    { jobId: `outbox-dispatcher-scheduler-tick:${shop}`, repeat: { every: repeatEveryMs } },
  );
}
