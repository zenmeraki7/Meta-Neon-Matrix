import { Queue } from "bullmq";
import { connection } from "../config/redis.js";
import { db } from "../repositories/repositoryDb.js";
import { OPERATION_LIFECYCLE_STATES } from "./operationLifecycleStateMachine.js";
import { normalizeEditHistoryExecutionState } from "../utils/normalizedStateUtils.js";
import { joinSafeJobId } from "../utils/jobQueueUtils.js";
import logger from "../utils/loggerUtils.js";

const queueByName = new Map();

function getQueue(queueName) {
  const requested = String(queueName || "").trim();
  const name = requested === "BULK_EDIT_PIPELINE"
    ? (process.env.BULK_EDIT_PIPELINE_QUEUE || "bulk-edit-pipeline")
    : requested === "SCHEDULED_EDIT"
      ? "scheduled-edit-queue"
      : requested;
  if (!name) throw new Error("JOB_CREATION_QUEUE_NAME_REQUIRED");
  if (!queueByName.has(name)) {
    queueByName.set(name, new Queue(name, { connection }));
  }
  return queueByName.get(name);
}

function deterministicJobId(queueName, shopId, jobId) {
  return joinSafeJobId(queueName, shopId, jobId);
}

async function dispatchIntent(intent) {
  const queue = getQueue(intent.queueKey);
  const options = intent.options && typeof intent.options === "object" ? intent.options : {};
  const payload = intent.payload && typeof intent.payload === "object" ? intent.payload : {};
  await queue.add(intent.jobName, payload, options);
}

async function createManualEditHistory(tx, { shopId, payload }) {
  const history = await tx.editHistory.create({
    data: {
      ...payload.historyData,
      shop: shopId,
      executionState: OPERATION_LIFECYCLE_STATES.QUEUED,
      executionStateNormalized: normalizeEditHistoryExecutionState(
        OPERATION_LIFECYCLE_STATES.QUEUED,
      ),
    },
  });
  const immutableEditCommand = payload.buildImmutableEditCommandForHistory(history);
  const updated = await tx.editHistory.updateMany({
    where: { id: history.id, shop: shopId },
    data: {
      batch: {
        ...(history.batch && typeof history.batch === "object" ? history.batch : {}),
        immutableEditCommand,
        targetSnapshotSet: {
          id: `EDIT_HISTORY:${history.id}`,
          ownerType: "EDIT_HISTORY",
          ownerId: history.id,
          sourceType: history.batch?.explicitProductIds?.length
            ? "MANUAL_SELECTION"
            : "FILTER",
          status: OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
        },
      },
    },
  });
  if (updated.count !== 1) throw new Error("BULK_EDIT_COMMAND_TENANT_UPDATE_CONFLICT");
  return history;
}

async function createBulkWriteJob(tx, { shopId, payload, idempotencyKey }) {
  const sessionId = String(payload.sessionId || "").trim();
  if (!sessionId) throw new Error("SESSION_NOT_FOUND");
  const sessionRows = await tx.$queryRaw`
    SELECT id, status
    FROM bulk_edit_sessions
    WHERE id = ${sessionId}::uuid AND shop_id = ${shopId}
    LIMIT 1
    FOR UPDATE
  `;
  const session = sessionRows[0] || null;
  if (!session) throw new Error("SESSION_NOT_FOUND");
  if (!["DRAFT", "COMMITTED"].includes(String(session.status).toUpperCase())) {
    throw new Error("SESSION_NOT_OPEN");
  }
  const existing = await tx.$queryRaw`
    SELECT *
    FROM sync_jobs
    WHERE shop_id = ${shopId}
      AND type = 'BULK_WRITE'
      AND meta->>'sessionId' = ${sessionId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (existing[0]) {
    return {
      ...existing[0],
      sessionId,
      changeCount: Number(
        existing[0].total_count
        ?? existing[0].meta?.changeCount
        ?? 0,
      ),
    };
  }
  const countRows = await tx.$queryRaw`
    SELECT COUNT(*)::int AS count
    FROM bulk_edit_changes
    WHERE session_id = ${sessionId}::uuid
      AND shop_id = ${shopId}
      AND status = 'PENDING'
  `;
  const changeCount = Number(countRows[0]?.count || 0);
  if (changeCount === 0) throw new Error("NO_PENDING_CHANGES");
  await tx.$executeRaw`
    UPDATE bulk_edit_sessions
    SET status = 'COMMITTED', updated_at = now()
    WHERE id = ${sessionId}::uuid AND shop_id = ${shopId}
  `;
  const rows = await tx.$queryRaw`
    INSERT INTO sync_jobs (shop_id, type, total_count, meta)
    VALUES (
      ${shopId},
      'BULK_WRITE',
      ${changeCount},
      ${JSON.stringify({ sessionId, changeCount, idempotencyKey })}::jsonb
    )
    RETURNING *
  `;
  return { ...rows[0], sessionId, changeCount };
}

export class JobCreationService {
  static async createAndEnqueue({
    shopId,
    operationType,
    payload = {},
    queueName,
    workerClass,
    idempotencyKey = null,
  }) {
    const shop = String(shopId || "").trim();
    const type = String(operationType || "").trim().toUpperCase();
    const jobName = String(workerClass || "").trim();
    const safeIdempotencyKey = String(idempotencyKey || "").trim() || null;
    if (!shop || !type || !queueName || !jobName) {
      throw new Error("JOB_CREATION_ARGUMENTS_REQUIRED");
    }

    const created = await db.$transaction(async (tx) => {
      let jobRecord;
      if (type === "MANUAL_BULK_EDIT") {
        jobRecord = await createManualEditHistory(tx, { shopId: shop, payload });
      } else if (type === "BULK_WRITE") {
        jobRecord = await createBulkWriteJob(tx, {
          shopId: shop,
          payload,
          idempotencyKey: safeIdempotencyKey,
        });
      } else {
        throw new Error(`JOB_CREATION_OPERATION_TYPE_UNSUPPORTED:${type}`);
      }
      const jobId = String(jobRecord.id);
      const queuePayload = type === "MANUAL_BULK_EDIT"
        ? {
            historyId: jobId,
            shop,
            source: payload.source || "manual_bulk_edit_pipeline",
            executionId: jobRecord.executionIdentity,
          }
        : {
            sessionId: jobRecord.sessionId,
            shop,
            syncJobId: jobId,
          };
      const options = {
        ...(payload.queueOptions || {}),
        jobId: deterministicJobId(queueName, shop, jobId),
      };
      const dedupeKey = type === "BULK_WRITE"
        ? `${type}:${shop}:${jobRecord.sessionId}`
        : `${type}:${safeIdempotencyKey || jobId}`;
      const intent = await tx.operationEnqueueIntent.upsert({
        where: {
          shop_queueKey_dedupeKey: {
            shop,
            queueKey: queueName,
            dedupeKey,
          },
        },
        create: {
          shop,
          queueKey: queueName,
          jobName,
          payload: queuePayload,
          options,
          dedupeKey,
          status: "PENDING",
        },
        update: {},
      });
      return { jobRecord, intent };
    });

    const dispatched = await JobCreationService.dispatchIntent(created.intent);
    return { ...created, dispatched, pendingRecovery: !dispatched };
  }

  static async dispatchIntent(intent) {
    try {
      const claimed = await db.operationEnqueueIntent.updateMany({
        where: {
          id: intent.id,
          shop: intent.shop,
          status: { in: ["PENDING", "DISPATCH_FAILED"] },
        },
        data: {
          status: "DISPATCHING",
          attempts: { increment: 1 },
        },
      });
      if (claimed.count !== 1) {
        return String(intent.status || "").toUpperCase() === "DISPATCHED";
      }
    } catch (error) {
      logger.warn("Failed to claim persisted enqueue intent for dispatch", {
        intentId: intent?.id,
        shop: intent?.shop,
        queueKey: intent?.queueKey,
        message: error?.message || String(error),
      });
      return false;
    }

    try {
      await dispatchIntent(intent);
    } catch (error) {
      try {
        await db.operationEnqueueIntent.updateMany({
          where: { id: intent.id, shop: intent.shop, status: "DISPATCHING" },
          data: {
            status: "DISPATCH_FAILED",
            lastError: error?.message || String(error),
            runAt: new Date(),
          },
        });
      } catch (statusError) {
        logger.warn("Failed to persist enqueue intent dispatch failure", {
          intentId: intent?.id,
          shop: intent?.shop,
          queueKey: intent?.queueKey,
          dispatchError: error?.message || String(error),
          statusError: statusError?.message || String(statusError),
        });
      }
      return false;
    }

    try {
      await db.operationEnqueueIntent.updateMany({
        where: { id: intent.id, shop: intent.shop, status: "DISPATCHING" },
        data: { status: "DISPATCHED", dispatchedAt: new Date(), lastError: null },
      });
    } catch (error) {
      logger.warn("Queue accepted job but DISPATCHED intent status update failed", {
        intentId: intent?.id,
        shop: intent?.shop,
        queueKey: intent?.queueKey,
        message: error?.message || String(error),
      });
    }
    return true;
  }
}

export default JobCreationService;
