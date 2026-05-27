import { prisma } from "../config/database.js";
import { scheduledEditQueue } from "../Jobs/Queues/scheduledEditQueue.js";
import { enqueueBulkEditTargetFreezeJob } from "../Jobs/Queues/bulkEditPipelineJob.js";

export const ENQUEUE_INTENT_STATUS = Object.freeze({
  PENDING: "PENDING",
  DISPATCHING: "DISPATCHING",
  DISPATCHED: "DISPATCHED",
  FAILED: "FAILED",
});

export const ENQUEUE_QUEUE_KEYS = Object.freeze({
  SCHEDULED_EDIT: "SCHEDULED_EDIT",
  BULK_EDIT_PIPELINE: "BULK_EDIT_PIPELINE",
});

function toObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;
}

export async function createEnqueueIntent({
  tx = prisma,
  shop,
  queueKey,
  jobName,
  payload,
  options = {},
  dedupeKey = null,
  runAt = new Date(),
}) {
  return tx.operationEnqueueIntent.create({
    data: {
      shop,
      queueKey,
      jobName,
      payload,
      options,
      dedupeKey,
      status: ENQUEUE_INTENT_STATUS.PENDING,
      runAt,
    },
  });
}

async function dispatchIntent(intent) {
  const payload = toObject(intent.payload, {});
  const options = toObject(intent.options, {});
  if (!options.jobId || String(options.jobId).trim().length === 0) {
    throw new Error(`Missing deterministic jobId for enqueue intent ${intent.id}`);
  }

  if (intent.queueKey === ENQUEUE_QUEUE_KEYS.SCHEDULED_EDIT) {
    await scheduledEditQueue.add(intent.jobName, payload, options);
    return;
  }

  if (intent.queueKey === ENQUEUE_QUEUE_KEYS.BULK_EDIT_PIPELINE) {
    await enqueueBulkEditTargetFreezeJob(payload, options);
    return;
  }

  throw new Error(`Unsupported enqueue queue key: ${intent.queueKey}`);
}

export async function dispatchPendingEnqueueIntents({
  shop,
  queueKey = null,
  limit = 50,
}) {
  const intents = await prisma.operationEnqueueIntent.findMany({
    where: {
      shop,
      status: ENQUEUE_INTENT_STATUS.PENDING,
      runAt: { lte: new Date() },
      ...(queueKey ? { queueKey } : {}),
    },
    orderBy: [{ runAt: "asc" }, { createdAt: "asc" }],
    take: limit,
  });

  let dispatched = 0;
  let failed = 0;

  for (const intent of intents) {
    const claimed = await prisma.operationEnqueueIntent.updateMany({
      where: {
        id: intent.id,
        shop,
        status: ENQUEUE_INTENT_STATUS.PENDING,
      },
      data: {
        status: ENQUEUE_INTENT_STATUS.DISPATCHING,
        attempts: { increment: 1 },
      },
    });

    if (claimed.count !== 1) {
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      await dispatchIntent(intent);
      // eslint-disable-next-line no-await-in-loop
      await prisma.operationEnqueueIntent.updateMany({
        where: {
          id: intent.id,
          shop,
          status: ENQUEUE_INTENT_STATUS.DISPATCHING,
        },
        data: {
          status: ENQUEUE_INTENT_STATUS.DISPATCHED,
          dispatchedAt: new Date(),
          lastError: null,
        },
      });
      dispatched += 1;
    } catch (error) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.operationEnqueueIntent.updateMany({
        where: {
          id: intent.id,
          shop,
          status: ENQUEUE_INTENT_STATUS.DISPATCHING,
        },
        data: {
          status: ENQUEUE_INTENT_STATUS.PENDING,
          lastError: error?.message || String(error),
        },
      });
      failed += 1;
    }
  }

  return {
    scanned: intents.length,
    dispatched,
    failed,
  };
}
