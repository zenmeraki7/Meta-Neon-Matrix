import { db } from "../repositories/repositoryDb.js";
import { enqueueTargetFreezeRequestedJob } from "../Jobs/Queues/targetFreezeQueue.js";
import { addbulkUndoJob } from "../Jobs/Queues/bulkUndoJob.js";
import logger from "../utils/loggerUtils.js";

const OUTBOX_STATUS = Object.freeze({
  PENDING: "PENDING",
  DISPATCHING: "DISPATCHING",
  DISPATCHED: "DISPATCHED",
  FAILED: "FAILED",
});

export async function dispatchPendingOutboxEvents({ limit = 50 } = {}) {
  const staleBefore = new Date(Date.now() - 5 * 60_000);
  await db.outboxEvent.updateMany({
    where: {
      status: OUTBOX_STATUS.DISPATCHING,
      updatedAt: { lt: staleBefore },
    },
    data: { status: OUTBOX_STATUS.PENDING },
  });
  const pending = await db.outboxEvent.findMany({
    where: { status: OUTBOX_STATUS.PENDING },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Number(limit) || 50),
  });

  for (const event of pending) {
    const claimed = await db.outboxEvent.updateMany({
      where: {
        id: event.id,
        status: OUTBOX_STATUS.PENDING,
      },
      data: {
        status: OUTBOX_STATUS.DISPATCHING,
        attemptCount: { increment: 1 },
        lastErrorCode: null,
        updatedAt: new Date(),
      },
    });

    if (claimed.count !== 1) {
      continue;
    }

    try {
      logger.info("undo.outbox.dispatch_started", {
        outboxEventId: event.id,
        shop: event.shop,
        undoExecutionId: event.aggregateId,
        eventType: event.eventType,
      });
      if (event.eventType === "TARGET_FREEZE_REQUESTED") {
        await enqueueTargetFreezeRequestedJob(event.payloadJson);
      } else if (event.eventType === "UNDO_REQUESTED") {
        const payload =
          event.payloadJson && typeof event.payloadJson === "object"
            ? event.payloadJson
            : {};
        const undoJob = await addbulkUndoJob(payload);
        logger.info("undo.outbox.enqueued", {
          outboxEventId: event.id,
          shop: event.shop,
          undoExecutionId: event.aggregateId,
          workerJobId: undoJob?.id || null,
        });
      } else {
        const unsupported = new Error(
          `Unsupported outbox event type: ${event.eventType}`
        );
        unsupported.code = "OUTBOX_EVENT_UNSUPPORTED";
        throw unsupported;
      }

      await db.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: OUTBOX_STATUS.DISPATCHED,
          dispatchedAt: new Date(),
          lastErrorCode: null,
          updatedAt: new Date(),
        },
      });
    } catch (error) {
      await db.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: OUTBOX_STATUS.PENDING,
          lastErrorCode: String(error?.code || "OUTBOX_DISPATCH_FAILED").slice(
            0,
            120
          ),
          lastErrorAt: new Date(),
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
    logger.error("undo.outbox.dispatch_failed", {
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
