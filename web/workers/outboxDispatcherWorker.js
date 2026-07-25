import crypto from "node:crypto";
import { db } from "../repositories/repositoryDb.js";
import { enqueueTargetFreezeRequestedJob } from "../Jobs/Queues/targetFreezeQueue.js";
import { addbulkUndoJob } from "../Jobs/Queues/bulkUndoJob.js";
import logger from "../utils/loggerUtils.js";
import { requireAggregateIdentity } from "../utils/polymorphicIdentity.js";

const OUTBOX_STATUS = Object.freeze({
  PENDING: "PENDING",
  DISPATCHING: "DISPATCHING",
  DISPATCHED: "DISPATCHED",
  DEAD_LETTER: "DEAD_LETTER",
});

const MAX_ATTEMPTS = Math.max(1, Number.parseInt(process.env.OUTBOX_MAX_ATTEMPTS || "10", 10));
const LOCK_TIMEOUT_MS = Math.max(30_000, Number.parseInt(process.env.OUTBOX_LOCK_TIMEOUT_MS || "300000", 10));
const BASE_RETRY_MS = Math.max(1_000, Number.parseInt(process.env.OUTBOX_RETRY_BASE_MS || "5000", 10));
const MAX_RETRY_MS = Math.max(BASE_RETRY_MS, Number.parseInt(process.env.OUTBOX_RETRY_MAX_MS || "900000", 10));

function retryDelayMs(attemptCount) {
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * (2 ** Math.max(0, attemptCount - 1)));
}

async function claimDueEvents({ limit, workerId, staleBefore }) {
  return db.$queryRaw`
    WITH candidates AS (
      SELECT "id"
      FROM "OutboxEvent"
      WHERE (
        ("statusNormalized" = 'PENDING'::"OutboxEventStatus" AND "nextAttemptAt" <= NOW())
        OR
        ("statusNormalized" = 'DISPATCHING'::"OutboxEventStatus" AND "lockedAt" < ${staleBefore})
      )
      ORDER BY "nextAttemptAt" ASC, "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE "OutboxEvent" AS event
    SET "status" = 'DISPATCHING',
        "statusNormalized" = 'DISPATCHING'::"OutboxEventStatus",
        "attemptCount" = event."attemptCount" + 1,
        "lockedAt" = NOW(),
        "lockedBy" = ${workerId},
        "lastErrorCode" = NULL,
        "updatedAt" = NOW()
    FROM candidates
    WHERE event."id" = candidates."id"
    RETURNING event.*
  `;
}

export async function dispatchPendingOutboxEvents({ limit = 50 } = {}) {
  const workerId = `outbox:${process.pid}:${crypto.randomUUID()}`;
  const claimedEvents = await claimDueEvents({
    limit: Math.max(1, Number(limit) || 50),
    workerId,
    staleBefore: new Date(Date.now() - LOCK_TIMEOUT_MS),
  });

  for (const event of claimedEvents) {
    try {
      logger.info("undo.outbox.dispatch_started", {
        outboxEventId: event.id,
        shop: event.shop,
        undoExecutionId: event.aggregateId,
        domainEventType: event.domainEventType,
      });
      if (event.domainEventType === "TARGET_FREEZE_REQUESTED") {
        requireAggregateIdentity(event, ["AUTOMATIC_PRODUCT_RULE_RUN"]);
        await enqueueTargetFreezeRequestedJob(event.payloadJson);
      } else if (event.domainEventType === "UNDO_REQUESTED") {
        requireAggregateIdentity(event, ["UNDO_EXECUTION"]);
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
          `Unsupported outbox event type: ${event.domainEventType}`
        );
        unsupported.code = "OUTBOX_EVENT_UNSUPPORTED";
        throw unsupported;
      }

      await db.outboxEvent.updateMany({
        where: { id: event.id, lockedBy: workerId, statusNormalized: OUTBOX_STATUS.DISPATCHING },
        data: {
          status: OUTBOX_STATUS.DISPATCHED,
          statusNormalized: OUTBOX_STATUS.DISPATCHED,
          dispatchedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          lastErrorCode: null,
          updatedAt: new Date(),
        },
      });
    } catch (error) {
      const exhausted = Number(event.attemptCount || 0) >= MAX_ATTEMPTS;
      await db.outboxEvent.updateMany({
        where: { id: event.id, lockedBy: workerId, statusNormalized: OUTBOX_STATUS.DISPATCHING },
        data: {
          status: exhausted ? OUTBOX_STATUS.DEAD_LETTER : OUTBOX_STATUS.PENDING,
          statusNormalized: exhausted ? OUTBOX_STATUS.DEAD_LETTER : OUTBOX_STATUS.PENDING,
          nextAttemptAt: exhausted
            ? new Date()
            : new Date(Date.now() + retryDelayMs(Number(event.attemptCount || 1))),
          lockedAt: null,
          lockedBy: null,
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
      domainEventType: event?.domainEventType || null,
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
