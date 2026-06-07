import { db } from "../repositories/repositoryDb.js";
import { JobCreationService } from "./JobCreationService.js";

export const ENQUEUE_INTENT_STATUS = Object.freeze({
  PENDING: "PENDING",
  DISPATCHING: "DISPATCHING",
  DISPATCHED: "DISPATCHED",
  DISPATCH_FAILED: "DISPATCH_FAILED",
});

export const ENQUEUE_QUEUE_KEYS = Object.freeze({
  SCHEDULED_EDIT: "SCHEDULED_EDIT",
  BULK_EDIT_PIPELINE: "BULK_EDIT_PIPELINE",
  BULK_EDIT_VERIFICATION: "bulk-edit-verification",
});

export async function createEnqueueIntent({
  tx = db,
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

export async function dispatchPendingEnqueueIntents({
  shop,
  queueKey = null,
  limit = 50,
}) {
  await db.operationEnqueueIntent.updateMany({
    where: {
      shop,
      status: ENQUEUE_INTENT_STATUS.DISPATCHING,
      updatedAt: { lt: new Date(Date.now() - 10 * 60 * 1000) },
      ...(queueKey ? { queueKey } : {}),
    },
    data: {
      status: ENQUEUE_INTENT_STATUS.DISPATCH_FAILED,
      lastError: "STALE_DISPATCH_CLAIM_RECOVERED",
      runAt: new Date(),
    },
  });

  const intents = await db.operationEnqueueIntent.findMany({
    where: {
      shop,
      status: { in: [ENQUEUE_INTENT_STATUS.PENDING, ENQUEUE_INTENT_STATUS.DISPATCH_FAILED] },
      runAt: { lte: new Date() },
      ...(queueKey ? { queueKey } : {}),
    },
    orderBy: [{ runAt: "asc" }, { createdAt: "asc" }],
    take: limit,
  });

  let dispatched = 0;
  let failed = 0;

  for (const intent of intents) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const didDispatch = await JobCreationService.dispatchIntent({
        ...intent,
      });
      if (didDispatch) dispatched += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }

  return {
    scanned: intents.length,
    dispatched,
    failed,
  };
}
