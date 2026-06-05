import { db } from "../repositories/repositoryDb.js";
import { enqueueTargetFreezeRequestedJob } from "../Jobs/Queues/targetFreezeQueue.js";

const OUTBOX_STATUS = Object.freeze({
  PENDING: "PENDING",
  DISPATCHING: "DISPATCHING",
  DISPATCHED: "DISPATCHED",
  FAILED: "FAILED",
});

export async function dispatchPendingOutboxEvents({ shop, limit = 50 } = {}) {
  const scopedShop = String(shop || "").trim();
  if (!scopedShop) {
    throw new Error("dispatchPendingOutboxEvents requires shop");
  }
  const pending = await db.outboxEvent.findMany({
    where: { shop: scopedShop, status: OUTBOX_STATUS.PENDING },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Number(limit) || 50),
  });

  for (const event of pending) {
    const claimed = await db.outboxEvent.updateMany({
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

    if (claimed.count !== 1) {
      continue;
    }

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
          updatedAt: new Date(),
        },
      });
    } catch (error) {
      await db.outboxEvent.updateMany({
        where: { id: event.id, shop: scopedShop },
        data: {
          status: OUTBOX_STATUS.PENDING,
          updatedAt: new Date(),
        },
      });
      await logDispatchError(event, error);
    }
  }
}

async function logDispatchError(event, error) {
  try {
    // Keep dispatcher resilient; outbox row remains retryable.
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
