import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { db } from "../../repositories/repositoryDb.js";
import logger from "../../utils/loggerUtils.js";
import { logWorkerError } from "../../utils/errorLogUtils.js";
import {
  BULK_UNDO_STATES,
  normalizeUndoState,
  buildPlannedUndoState,
} from "../../services/bulkEditExecutionStateService.js";
import { addbulkUndoJob } from "../../Jobs/Queues/bulkUndoJob.js";
import crypto from "crypto";
import {
  enqueueBulkEditMutationPlanJob,
  enqueueBulkEditTargetFreezeJob,
} from "../Queues/bulkEditPipelineJob.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../../services/operationLifecycleStateMachine.js";
import { loadAuthoritativeSubscriptionForShop } from "../../services/subscriptionAuthorityService.js";
import { getPlanMaxBulkEditTargets } from "../../services/bulkEdit/bulkEditPlanUtils.js";
import { assertMirrorSafeForTargeting } from "../../services/mirrorHealthService.js";

import { clearKeyCaches } from "../../utils/cacheUtils.js";
import { renewRedisLock } from "../../utils/redisLockUtils.js";

const SCHEDULED_RUN_LOCK_TTL_MS = 10 * 60 * 1000;

function buildScheduledRunLockKey({ shop, historyId, scheduledAt, jobName }) {
  const atMs = new Date(scheduledAt || 0).getTime() || 0;
  return `scheduled-run-lock:${shop}:${historyId}:${atMs}:${jobName || "scheduled-task"}`;
}

async function acquireScheduledRunLock({ shop, historyId, scheduledAt, jobName }) {
  const lockKey = buildScheduledRunLockKey({ shop, historyId, scheduledAt, jobName });
  const token = crypto.randomUUID();
  const acquired = await connection.set(lockKey, token, "NX", "PX", SCHEDULED_RUN_LOCK_TTL_MS);
  if (acquired !== "OK") {
    return { acquired: false, lockKey: null, token: null };
  }
  return { acquired: true, lockKey, token };
}

async function releaseScheduledRunLock({ lockKey, token }) {
  if (!lockKey || !token) return;
  const lua = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    end
    return 0
  `;
  await connection.eval(lua, 1, lockKey, token).catch(() => {});
}

async function claimScheduledEdit(historyId, shop) {
  const result = await db.editHistory.updateMany({
    where: {
      id: historyId,
      shop,
      status: "pending",
    },
    data: {
      status: "processing",
      statusNormalized: normalizeEditHistoryStatus("processing"),
      executionState: OPERATION_LIFECYCLE_STATES.SCHEDULED_QUEUED,
      executionStateNormalized: normalizeEditHistoryExecutionState(
        OPERATION_LIFECYCLE_STATES.SCHEDULED_QUEUED,
      ),
    },
  });

  return result.count === 1;
}

async function claimScheduledUndo(historyId, shop) {
  const history = await db.editHistory.findFirst({
    where: {
      id: historyId,
      shop,
      status: "completed", // important
    },
    select: {
      undo: true,
    },
  });

  if (!history) return false;

  const undo = normalizeUndoState(
    history.undo,
    buildPlannedUndoState({ allowed: false }),
  );

  if (!undo.allowed) return false;

  if (
    [
      BULK_UNDO_STATES.QUEUED,
      BULK_UNDO_STATES.CHANGE_RECORDS_PENDING,
      BULK_UNDO_STATES.DISPATCHING,
      BULK_UNDO_STATES.AWAITING_CONFIRMATION,
      BULK_UNDO_STATES.RECONCILE_SUBMITTED,
      BULK_UNDO_STATES.AWAITING_SHOPIFY,
      BULK_UNDO_STATES.FINALIZING,
      BULK_UNDO_STATES.COMPLETED,
    ].includes(undo.state)
  ) {
    return false;
  }

  const executionIdentity = undo.executionIdentity || crypto.randomUUID();

  const updated = await db.editHistory.updateMany({
    where: {
      id: historyId,
      shop,
      status: "completed",
      OR: [
        { undo: { path: ["state"], equals: BULK_UNDO_STATES.PLANNED } },
        { undo: { path: ["state"], equals: BULK_UNDO_STATES.FAILED } },
        { undo: { path: ["state"], equals: BULK_UNDO_STATES.PARTIAL } },
      ],
    },
    data: {
      undo: {
        ...undo,
        status: "pending",
        state: BULK_UNDO_STATES.QUEUED,
        queuedAt: new Date(),
        startedAt: null,
        completedAt: null,
        processedCount: 0,
        durationMs: 0,
        bulkOperationId: null,
        executionIdentity,
        error: null,
      },
    },
  });

  if (!updated.count) return false;

  await clearKeyCaches(`${shop}:fetchHistories`);
  await clearKeyCaches(`${shop}:historyDetails:${historyId}`);

  await addbulkUndoJob({
    historyId,
    shop,
    source: "scheduled_undo",
    executionId: executionIdentity,
  });

  return true;
}

async function blockScheduledEdit({
  historyId,
  shop,
  historyBatch,
  reason,
  message,
}) {
  await db.editHistory.updateMany({
    where: {
      id: historyId,
      shop,
      status: "processing",
    },
    data: {
      status: "failed",
      statusNormalized: normalizeEditHistoryStatus("failed"),
      executionState: OPERATION_LIFECYCLE_STATES.FAILED,
      executionStateNormalized: normalizeEditHistoryExecutionState(
        OPERATION_LIFECYCLE_STATES.FAILED,
      ),
      failureStage: reason,
      completedAt: new Date(),
      batch: {
        ...(historyBatch && typeof historyBatch === "object" ? historyBatch : {}),
        scheduledBlock: {
          reason,
          message,
          blockedAt: new Date().toISOString(),
        },
      },
    },
  });
}

const scheduledEditWorker = new Worker(
  "scheduled-edit-queue",
  async (job) => {
    const historyId = job.data?.historyId;
    const shop = job.data?.shop;
    const isUndo = job.name === "undo-task";

    if (!historyId || !shop) {
      throw new Error("scheduled-edit job requires historyId and shop");
    }

    let scheduledRunLock = null;
    let scheduledRunLockHeartbeat = null;
    try {
      const lockContext = await db.editHistory.findFirst({
        where: { id: historyId, shop },
        select: { scheduledAt: true },
      });
      scheduledRunLock = await acquireScheduledRunLock({
        shop,
        historyId,
        scheduledAt: lockContext?.scheduledAt || null,
        jobName: job.name,
      });
      if (!scheduledRunLock?.acquired) {
        return {
          skipped: true,
          reason: "scheduled_run_lock_conflict",
        };
      }
      scheduledRunLockHeartbeat = setInterval(() => {
        renewRedisLock({
          connection,
          key: scheduledRunLock.lockKey,
          token: scheduledRunLock.token,
          ttlMs: SCHEDULED_RUN_LOCK_TTL_MS,
        }).catch(() => {});
      }, 30_000);

      const claimed = isUndo
        ? await claimScheduledUndo(historyId, shop)
        : await claimScheduledEdit(historyId, shop);

      if (!claimed) {
        return {
          skipped: true,
          reason: "already_claimed",
        };
      }

      if (isUndo) {
        return { success: true, type: "scheduled_undo_enqueued" };
      }
      const scheduledHistory = await db.editHistory.findFirst({
        where: { id: historyId, shop },
        select: {
          executionIdentity: true,
          targetSnapshotCount: true,
          totalItems: true,
          batch: true,
        },
      });
      if (!scheduledHistory) {
        throw new Error("scheduled history not found after claim");
      }
      const subscription = await loadAuthoritativeSubscriptionForShop(shop);
      const maxTargets = getPlanMaxBulkEditTargets(subscription);
      const targetCount = Number(
        scheduledHistory.targetSnapshotCount
        || scheduledHistory.batch?.previewCount
        || scheduledHistory.totalItems
        || 0,
      );
      if (Number.isFinite(maxTargets) && targetCount > maxTargets) {
        await blockScheduledEdit({
          historyId,
          shop,
          historyBatch: scheduledHistory.batch,
          reason: "SCHEDULED_EDIT_ENTITLEMENT_BLOCKED",
          message: `Target count ${targetCount} exceeds plan limit ${maxTargets}`,
        });
        return { skipped: true, reason: "entitlement_blocked", targetCount, maxTargets };
      }
      try {
        await assertMirrorSafeForTargeting(shop, { purpose: "EXECUTE" });
      } catch (error) {
        await blockScheduledEdit({
          historyId,
          shop,
          historyBatch: scheduledHistory.batch,
          reason: "SCHEDULED_EDIT_MIRROR_UNSAFE",
          message: String(error?.message || "Mirror is not safe for execution"),
        });
        return { skipped: true, reason: "mirror_unsafe" };
      }
      const executionIdentity = scheduledHistory?.executionIdentity || historyId;
      const freezeMode = String(scheduledHistory?.batch?.freezeMode || "DYNAMIC_AT_RUN").toUpperCase();
      if (
        freezeMode === "STATIC_AT_SCHEDULE_CREATE"
        && Number(scheduledHistory?.targetSnapshotCount || 0) > 0
      ) {
        await enqueueBulkEditMutationPlanJob({
          historyId,
          shop,
          executionId: executionIdentity,
          source: "scheduled_edit_prefrozen",
        });
      } else {
        await enqueueBulkEditTargetFreezeJob({
          historyId,
          shop,
          executionId: executionIdentity,
          source: "scheduled_edit",
        });
      }
      return { success: true, type: "scheduled_edit_enqueued" };
    } catch (error) {
      await logWorkerError({
        shop,
        err: error,
        source: "scheduledEditWorker",
      });
      throw error;
    } finally {
      if (scheduledRunLockHeartbeat) {
        clearInterval(scheduledRunLockHeartbeat);
      }
      await releaseScheduledRunLock(scheduledRunLock || {});
    }
  },
  { connection, concurrency: 1 },
);

scheduledEditWorker.on("failed", (job, error) => {
  logger.error("Scheduled edit worker failed", {
    worker: "scheduledEditWorker",
    jobId: job?.id,
    shop: job?.data?.shop,
    historyId: job?.data?.historyId,
    message: error.message,
  });
});

export default scheduledEditWorker;
