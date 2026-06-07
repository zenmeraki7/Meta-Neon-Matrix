import { db } from "../repositories/repositoryDb.js";
import { enqueueTargetFreezeRequestedJob } from "../Jobs/Queues/targetFreezeQueue.js";

const OUTBOX_STATUS = Object.freeze({
  PENDING: "PENDING",
  DISPATCHING: "DISPATCHING",
  DISPATCHED: "DISPATCHED",
});
const DISPATCHED_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export async function dispatchPendingOutboxEvents({ shop, limit = 50 } = {}) {
  const scopedShop = String(shop || "").trim();
  if (!scopedShop) {
    throw new Error("dispatchPendingOutboxEvents requires shop");
  }

  const batchLimit = Math.max(1, Number(limit) || 50);
  const pending = await db.outboxEvent.findMany({
    where: { shop: scopedShop, status: OUTBOX_STATUS.PENDING },
    orderBy: { createdAt: "asc" },
    take: batchLimit,
  });

  let claimed = 0;
  let dispatched = 0;
  let failed = 0;

  for (const event of pending) {
    const claim = await db.outboxEvent.updateMany({
      where: {
        id: event.id,
        shop: scopedShop,
        status: OUTBOX_STATUS.PENDING,
      },
      data: {
        status: OUTBOX_STATUS.DISPATCHING,
        updatedAt: new Date(),
      },
    });

    if (claim.count !== 1) {
      continue;
    }
    claimed += 1;

    try {
      if (event.eventType === "TARGET_FREEZE_REQUESTED") {
        await enqueueTargetFreezeRequestedJob(event.payloadJson, {
          jobId: `${event.eventType}:${event.aggregateId}`,
        });
      }

      await db.outboxEvent.updateMany({
        where: { id: event.id, shop: scopedShop },
        data: {
          status: OUTBOX_STATUS.DISPATCHED,
          dispatchedAt: new Date(),
          purgeAfter: new Date(Date.now() + DISPATCHED_OUTBOX_RETENTION_MS),
          updatedAt: new Date(),
        },
      });
      dispatched += 1;
    } catch (error) {
      await db.outboxEvent.updateMany({
        where: { id: event.id, shop: scopedShop },
        data: {
          status: OUTBOX_STATUS.PENDING,
          updatedAt: new Date(),
        },
      });
      failed += 1;
      logDispatchError(event, error);
    }
  }

  const remaining = await db.outboxEvent.count({
    where: { shop: scopedShop, status: OUTBOX_STATUS.PENDING },
  });

  return {
    selected: pending.length,
    claimed,
    dispatched,
    failed,
    remaining,
    batchLimit,
    batchLimitReached: pending.length >= batchLimit,
  };
}

function logDispatchError(event, error) {
  try {
    // Keep dispatcher resilient; outbox row remains retryable on the next tick.
    // eslint-disable-next-line no-console
    console.error("Outbox dispatch failed", {
      outboxEventId: event?.id || null,
      eventType: event?.eventType || null,
      aggregateId: event?.aggregateId || null,
      message: error?.message || "Unknown dispatch error",
    });
  } catch {
    // noop
  }
}

export default {
  dispatchPendingOutboxEvents,
};
