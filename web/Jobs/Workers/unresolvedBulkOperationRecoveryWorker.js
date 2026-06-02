import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { db } from "../../repositories/repositoryDb.js";
import logger from "../../utils/loggerUtils.js";
import { addbulkEditResultIngestJob } from "../Queues/bulkEditResultIngestJob.js";
import { addbulkUndoResultIngestJob } from "../Queues/bulkUndoResultIngestJob.js";
import {
  acquireRedisLock,
  releaseRedisLock,
} from "../../utils/redisLockUtils.js";
import { enqueueUnresolvedBulkOperationRecoveryTick } from "../../queues/adapters/workerSchedulerQueueAdapter.js";

const QUEUE_NAME = "unresolved-bulk-operation-recovery";
const POLL_INTERVAL_MS = 60_000;
const LIMIT = 100;
const LEADER_LOCK_KEY = "leader:unresolved-bulk-operation-recovery:scheduler";
const LEADER_LOCK_TTL_MS = 45_000;

async function resolveAndDispatch(row) {
  const shop = row.shop;
  const bulkOperationId = row.entityId;
  if (!shop || !bulkOperationId) return { resolved: false, reason: "missing_identity" };
  const claimed = await db.webhookDelivery.updateMany({
    where: {
      id: row.id,
      status: "QUEUED",
    },
    data: {
      status: "DISPATCHING",
    },
  });
  if (claimed.count !== 1) {
    return { resolved: false, reason: "already_claimed" };
  }

  const edit = await db.bulkSubmission.findUnique({
    where: {
      shop_shopifyBulkOperationId: {
        shop,
        shopifyBulkOperationId: String(bulkOperationId),
      },
    },
    select: { editHistoryId: true },
  });

  if (edit?.editHistoryId) {
    await addbulkEditResultIngestJob({
      shop,
      bulkOperationId,
      source: "unresolved_bulk_operation_recovery",
    });
    await db.webhookDelivery.updateMany({
      where: { id: row.id, status: "DISPATCHING" },
      data: { status: "PROCESSED", lastError: null, processedAt: new Date() },
    });
    return { resolved: true, kind: "edit" };
  }

  const undoOwner = await db.editHistory.findFirst({
    where: {
      shop,
      undo: {
        path: ["bulkOperationId"],
        equals: String(bulkOperationId),
      },
    },
    select: { id: true },
  });
  if (undoOwner?.id) {
    await addbulkUndoResultIngestJob({
      shop,
      bulkOperationId,
      source: "unresolved_bulk_operation_recovery",
    });
    await db.webhookDelivery.updateMany({
      where: { id: row.id, status: "DISPATCHING" },
      data: { status: "PROCESSED", lastError: null, processedAt: new Date() },
    });
    return { resolved: true, kind: "undo" };
  }

  await db.webhookDelivery.updateMany({
    where: { id: row.id, status: "DISPATCHING" },
    data: {
      status: "QUEUED",
      attemptCount: { increment: 1 },
      lastError: "UNRESOLVED_BULK_OPERATION_OWNER",
    },
  });
  return { resolved: false, reason: "owner_not_found" };
}

async function runTick() {
  const rows = await db.webhookDelivery.findMany({
    where: {
      topic: "bulk_operations/finish_unresolved",
      status: "QUEUED",
      entityId: { not: null },
    },
    orderBy: { updatedAt: "asc" },
    take: LIMIT,
  });

  let resolved = 0;
  let unresolved = 0;
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const result = await resolveAndDispatch(row);
    if (result.resolved) resolved += 1;
    else unresolved += 1;
  }
  return { scanned: rows.length, resolved, unresolved };
}

export const unresolvedBulkOperationRecoveryWorker = new Worker(
  QUEUE_NAME,
  async () => runTick(),
  { connection, concurrency: 1 },
);

unresolvedBulkOperationRecoveryWorker.on("completed", (job, result) => {
  logger.info("Unresolved bulk operation recovery completed", {
    worker: "unresolvedBulkOperationRecoveryWorker",
    queue: QUEUE_NAME,
    jobId: job?.id,
    result,
  });
});

unresolvedBulkOperationRecoveryWorker.on("failed", (job, error) => {
  logger.error("Unresolved bulk operation recovery failed", {
    worker: "unresolvedBulkOperationRecoveryWorker",
    queue: QUEUE_NAME,
    jobId: job?.id,
    message: error?.message || String(error),
  });
});

async function registerRepeatableTick() {
  const leaderLock = await acquireRedisLock({
    connection,
    key: LEADER_LOCK_KEY,
    ttlMs: LEADER_LOCK_TTL_MS,
  });
  if (!leaderLock.acquired) return;

  try {
    await enqueueUnresolvedBulkOperationRecoveryTick(POLL_INTERVAL_MS);
  } finally {
    await releaseRedisLock({
      connection,
      key: leaderLock.key,
      token: leaderLock.token,
    }).catch(() => {});
  }
}

await registerRepeatableTick();

export default unresolvedBulkOperationRecoveryWorker;

