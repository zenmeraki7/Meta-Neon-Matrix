import { db } from "../repositories/repositoryDb.js";
import { scheduledEditQueue } from "../Jobs/Queues/scheduledEditQueue.js";
import { enqueueBulkEditTargetFreezeJob } from "../Jobs/Queues/bulkEditPipelineJob.js";
import crypto from "node:crypto";

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
  tx = db,
  shop,
  queueRoutingKey,
  queueJobName,
  payload,
  options = {},
  dispatchDedupeKey = null,
  availableAt = new Date(),
}) {
  return tx.operationEnqueueIntent.create({
    data: {
      shop,
      queueRoutingKey,
      queueJobName,
      payload,
      options,
      dispatchDedupeKey,
      status: ENQUEUE_INTENT_STATUS.PENDING,
      availableAt,
    },
  });
}

async function dispatchIntent(intent) {
  const payload = toObject(intent.payload, {});
  const options = toObject(intent.options, {});
  if (!options.jobId || String(options.jobId).trim().length === 0) {
    throw new Error(`Missing deterministic jobId for enqueue intent ${intent.id}`);
  }

  if (intent.queueRoutingKey === ENQUEUE_QUEUE_KEYS.SCHEDULED_EDIT) {
    await scheduledEditQueue.add(intent.queueJobName, payload, options);
    return;
  }

  if (intent.queueRoutingKey === ENQUEUE_QUEUE_KEYS.BULK_EDIT_PIPELINE) {
    await enqueueBulkEditTargetFreezeJob(payload, options);
    return;
  }

  throw new Error(`Unsupported enqueue queue key: ${intent.queueRoutingKey}`);
}

export async function dispatchPendingEnqueueIntents({
  shop = null,
  queueRoutingKey = null,
  limit = 50,
  staleAfterMs = 5 * 60 * 1000,
}) {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - staleAfterMs);
  const dispatchOwnerId = crypto.randomUUID();
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 500));
  const intents = await db.$queryRaw`
    WITH candidates AS (
      SELECT "id"
      FROM "OperationEnqueueIntent"
      WHERE (${shop}::text IS NULL OR "shop" = ${shop})
        AND (${queueRoutingKey}::text IS NULL OR "queueKey" = ${queueRoutingKey})
        AND (
          ("status" = 'PENDING'::"OperationEnqueueIntentStatus" AND "runAt" <= ${now})
          OR (
            "status" = 'DISPATCHING'::"OperationEnqueueIntentStatus"
            AND COALESCE("dispatchHeartbeatAt", "dispatchStartedAt", "updatedAt") < ${staleBefore}
          )
        )
      ORDER BY "runAt" ASC, "createdAt" ASC, "id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${boundedLimit}
    )
    UPDATE "OperationEnqueueIntent" intent
    SET "status" = 'DISPATCHING'::"OperationEnqueueIntentStatus",
        "attempts" = intent."attempts" + 1,
        "dispatchStartedAt" = ${now},
        "dispatchHeartbeatAt" = ${now},
        "dispatchOwner" = ${dispatchOwnerId},
        "updatedAt" = ${now}
    FROM candidates
    WHERE intent."id" = candidates."id"
    RETURNING intent."id", intent."shop", intent."payload", intent."options",
      intent."queueKey" AS "queueRoutingKey",
      intent."jobName" AS "queueJobName"
  `;

  let dispatched = 0;
  let failed = 0;

  for (const intent of intents) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await dispatchIntent(intent);
      // eslint-disable-next-line no-await-in-loop
      await db.operationEnqueueIntent.updateMany({
        where: {
          id: intent.id,
          shop: intent.shop,
          status: ENQUEUE_INTENT_STATUS.DISPATCHING,
          dispatchOwnerId,
        },
        data: {
          status: ENQUEUE_INTENT_STATUS.DISPATCHED,
          dispatchedAt: new Date(),
          lastError: null,
          dispatchHeartbeatAt: new Date(),
          dispatchOwnerId: null,
        },
      });
      dispatched += 1;
    } catch (error) {
      // eslint-disable-next-line no-await-in-loop
      await db.operationEnqueueIntent.updateMany({
        where: {
          id: intent.id,
          shop: intent.shop,
          status: ENQUEUE_INTENT_STATUS.DISPATCHING,
          dispatchOwnerId,
        },
        data: {
          status: ENQUEUE_INTENT_STATUS.PENDING,
          lastError: error?.message || String(error),
          dispatchStartedAt: null,
          dispatchHeartbeatAt: null,
          dispatchOwnerId: null,
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
