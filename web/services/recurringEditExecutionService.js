import { Prisma } from "../generated/prisma/index.js";
import { Queue } from "bullmq";
import { connection } from "../config/redis.js";
import { prisma } from "../config/database.js";
import { recurringEditRepository } from "../repositories/recurringEditRepository.js";
import { recurringEditRunRepository } from "../repositories/recurringEditRunRepository.js";
import { computeRecurringEditNextRunAt } from "./recurringEditScheduleService.js";
import { getSession } from "../utils/sessionHandler.js";
import { logWorkerError } from "../utils/errorLogUtils.js";
import logger from "../utils/loggerUtils.js";
import ProductBulkService from "./productService/productBulkEditService.js";
import { createMultiLanguage } from "../utils/googleTranslator.js";
import { getCurrentBulkOperationStatus } from "../utils/bulkOperationHelper.js";
import {
  acquireExclusiveShopWork,
  LOCK_NS,
  releaseExclusiveShopWork,
} from "./shopWorkLeaseService.js";
import {
  buildActorContext,
  buildEntitlementSnapshot,
} from "../utils/operationContextUtils.js";
import { getTargetingVersionBundle } from "./targeting/versioning.js";
import { OPERATION_LIFECYCLE_STATES } from "./operationLifecycleStateMachine.js";
import { normalizeEditHistoryExecutionState } from "../utils/normalizedStateUtils.js";
import {
  createEnqueueIntent,
  dispatchPendingEnqueueIntents,
  ENQUEUE_QUEUE_KEYS,
} from "./operationEnqueueIntentService.js";

export const RECURRING_EDIT_EXECUTION_QUEUE =
  process.env.RECURRING_EDIT_EXECUTION_QUEUE || "recurring-edit-execution";

const recurringEditExecutionQueue = new Queue(RECURRING_EDIT_EXECUTION_QUEUE, {
  connection,
});

// ✅ Keep advisory lock only for transactional use inside prisma.$transaction
async function tryAdvisoryLock(client, lockKey, transactional = true) {
  if (transactional) {
    const rows = await client.$queryRaw`
      SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})) AS locked
    `;
    return Boolean(rows?.[0]?.locked);
  }

  const rows = await client.$queryRaw`
    SELECT pg_try_advisory_lock(hashtext(${lockKey})) AS locked
  `;
  return Boolean(rows?.[0]?.locked);
}

// ✅ Redis locks for scheduler and shop — replaces pg_advisory_lock session locks
const SCHEDULER_LOCK_KEY = "lock:recurring-edit-scheduler";
const SCHEDULER_LOCK_TTL_MS = 55_000;

async function acquireSchedulerLock() {
  const result = await connection.set(
    SCHEDULER_LOCK_KEY,
    process.pid,
    "NX",
    "PX",
    SCHEDULER_LOCK_TTL_MS,
  );
  return result === "OK";
}

async function releaseSchedulerLock() {
  await connection.del(SCHEDULER_LOCK_KEY).catch(() => {});
}

async function acquireShopLock(shop) {
  const key = `lock:recurring-edit-shop:${shop}`;
  const result = await connection.set(key, process.pid, "NX", "PX", 120_000);
  return { acquired: result === "OK", key };
}

async function releaseShopLock(key) {
  if (key) await connection.del(key).catch(() => {});
}

function buildExecutionKey(recurringEditId, scheduledFor) {
  return `${recurringEditId}:${new Date(scheduledFor).toISOString()}`;
}

function isTerminalRunStatus(status) {
  return ["SUCCESS", "FAILED", "SKIPPED"].includes(status);
}

function isRunnableRecurringEdit(recurringEdit) {
  return recurringEdit && !recurringEdit.isDeleted && recurringEdit.status === "ACTIVE";
}

function buildDeferredResult(reason, runId, recurringEditId = null) {
  return {
    success: true,
    deferred: true,
    reason,
    runId,
    recurringEditId,
  };
}

function buildRecurringEditHistoryBody(recurringEdit) {
  const [rule] = Array.isArray(recurringEdit.rules) ? recurringEdit.rules : [];
  if (!rule) {
    throw new Error("Recurring edit rule not found");
  }

  return {
    editedField: rule.field,
    editedType: rule.editOption,
    filterParams: [],
    value: rule.value ?? null,
    searchKey: rule.searchKey ?? null,
    replaceText: rule.replaceText ?? null,
    supportValue: rule.supportValue ?? null,
    locationId: rule.locationId ?? null,
    operationKey: recurringEdit?.targetingSnapshotMeta?.operationKey || null,
  };
}

function resolveRecurringCompilerVersions(recurringEdit) {
  const current = getTargetingVersionBundle().targetingCompilerVersion;
  const meta = recurringEdit?.targetingSnapshotMeta && typeof recurringEdit.targetingSnapshotMeta === "object"
    ? recurringEdit.targetingSnapshotMeta
    : {};
  const created =
    String(meta?.createdCompilerVersion || "").trim() ||
    String(recurringEdit?.targetingCompilerVersion || "").trim() ||
    null;

  return {
    createdCompilerVersion: created,
    currentCompilerVersion: current,
    versionsMatch: created ? created === current : true,
  };
}

async function markRunFailed(run, recurringEdit, errorMessage) {
  const transition = await recurringEditRunRepository.markProcessingFinished(
    run.id,
    "FAILED",
    { errorMessage },
  );

  if (!transition.count) return null;

  await recurringEditRepository.updateByIdForShop({
    id: recurringEdit.id,
    shop: recurringEdit.shop,
    data: {
      runCount: { increment: 1 },
      lastRunAt: new Date(),
      lastFailureAt: new Date(),
      lastFailureReason: errorMessage,
    },
  });

  return errorMessage;
}

async function markRunSkipped(run, recurringEdit, reason) {
  const transition = await recurringEditRunRepository.markPendingSkipped(run.id, {
    errorMessage: reason,
  });

  if (!transition.count) return null;

  await recurringEditRepository.updateByIdForShop({
    id: recurringEdit.id,
    shop: recurringEdit.shop,
    data: {
      runCount: { increment: 1 },
      lastRunAt: new Date(),
    },
  });

  return reason;
}

export async function enqueueRecurringEditExecutionJob({ runId, shop }) {
  return recurringEditExecutionQueue.add(
    "recurring-edit-execution",
    { runId, shop },
    {
      jobId: runId,
      removeOnComplete: 100,
      removeOnFail: 100,
      attempts: 6,
      backoff: {
        type: "exponential",
        delay: 30_000,
      },
    },
  );
}

export async function scheduleDueRecurringEditRuns({ limit = 100 } = {}) {
  // ✅ Redis lock instead of pg_advisory_lock
  const hasSchedulerLock = await acquireSchedulerLock();
  if (!hasSchedulerLock) {
    return { scheduled: 0, skipped: 0, reason: "scheduler_locked" };
  }

  try {
    const now = new Date();
    const dueIds = await recurringEditRepository.findDueRecurringEditIds(now, limit);
    let scheduled = 0;
    let skipped = 0;

    for (const { id } of dueIds) {
      try {
        const reservation = await prisma.$transaction(async (tx) => {
          const locked = await tryAdvisoryLock(tx, `recurring-edit:${id}`, true);
          if (!locked) return null;

          const recurringEdit = await recurringEditRepository.findById(id, tx);
          if (
            !isRunnableRecurringEdit(recurringEdit) ||
            !recurringEdit.nextRunAt ||
            recurringEdit.nextRunAt > now
          ) {
            return null;
          }

          const scheduledFor = recurringEdit.nextRunAt;
          const executionKey = buildExecutionKey(id, scheduledFor);
          const existingRun = await recurringEditRunRepository.findByExecutionKey(
            executionKey,
            tx,
          );

          if (existingRun) {
            return { runId: existingRun.id, shop: recurringEdit.shop };
          }

          const run = await recurringEditRunRepository.create(
            {
              recurringEditId: recurringEdit.id,
              shop: recurringEdit.shop,
              scheduledFor,
              status: "PENDING",
              executionKey,
            },
            tx,
          );

          const nextRunAt = computeRecurringEditNextRunAt(
            recurringEdit,
            new Date(scheduledFor.getTime() + 1000),
          );

          await recurringEditRepository.updateByIdForShop(
            {
              id: recurringEdit.id,
              shop: recurringEdit.shop,
              data: {
                nextRunAt,
                status: nextRunAt ? "ACTIVE" : "COMPLETED",
              },
            },
            tx,
          );

          return { runId: run.id, shop: recurringEdit.shop };
        });

        if (!reservation?.runId) {
          skipped += 1;
          continue;
        }

        await enqueueRecurringEditExecutionJob({
          runId: reservation.runId,
          shop: reservation.shop,
        });
        scheduled += 1;
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          skipped += 1;
          continue;
        }

        await logWorkerError({
          shop: "unknown",
          err: error,
          source: "RecurringEditExecutionService.scheduleDueRecurringEditRuns",
        });
        skipped += 1;
      }
    }

    return { scheduled, skipped, scanned: dueIds.length };
  } finally {
    await releaseSchedulerLock(); // ✅ always releases
  }
}

export async function executeRecurringEditRun(runId, shopFromJob = null) {
  let run = await recurringEditRunRepository.findByIdWithRecurringEdit(runId);
  if (!run) return { skipped: true, reason: "run_not_found" };

  if (isTerminalRunStatus(run.status)) {
    return { skipped: true, reason: "run_already_completed" };
  }

  const recurringEdit = run.recurringEdit;
  if (shopFromJob && recurringEdit?.shop && recurringEdit.shop !== shopFromJob) {
    throw new Error("Cross-shop recurring edit execution blocked");
  }
  if (!isRunnableRecurringEdit(recurringEdit)) {
    await markRunSkipped(run, recurringEdit || { id: run.recurringEditId }, "Recurring edit is not active");
    return { skipped: true, reason: "recurring_edit_inactive" };
  }

  // ✅ Redis lock instead of pg_advisory_lock
  const shopLock = await acquireShopLock(recurringEdit.shop);
  if (!shopLock.acquired) {
    return buildDeferredResult("shop_execution_locked", run.id, recurringEdit.id);
  }

  let exclusiveShopLockKey = null;

  try {
    run = await recurringEditRunRepository.findByIdWithRecurringEdit(runId);
    if (!run || isTerminalRunStatus(run.status)) {
      return { skipped: true, reason: "run_not_actionable" };
    }

    const currentRecurringEdit = run.recurringEdit;
    if (!isRunnableRecurringEdit(currentRecurringEdit)) {
      await markRunSkipped(run, currentRecurringEdit, "Recurring edit is not active");
      return { skipped: true, reason: "recurring_edit_inactive_after_lock" };
    }
    const compilerVersions = resolveRecurringCompilerVersions(currentRecurringEdit);
    if (!compilerVersions.versionsMatch) {
      const mismatchReason =
        `Recurring edit paused due to compiler version change (${compilerVersions.createdCompilerVersion} -> ${compilerVersions.currentCompilerVersion}). Merchant confirmation is required before resuming.`;
      await recurringEditRepository.updateByIdForShop({
        id: currentRecurringEdit.id,
        shop: currentRecurringEdit.shop,
        data: {
          status: "PAUSED",
          nextRunAt: null,
          lastFailureAt: new Date(),
          lastFailureReason: mismatchReason,
          targetingSnapshotMeta: {
            ...(currentRecurringEdit.targetingSnapshotMeta || {}),
            createdCompilerVersion: compilerVersions.createdCompilerVersion,
            currentCompilerVersion: compilerVersions.currentCompilerVersion,
            compatibilityEvent: {
              type: "COMPILER_VERSION_MISMATCH_PAUSED",
              at: new Date().toISOString(),
              createdCompilerVersion: compilerVersions.createdCompilerVersion,
              currentCompilerVersion: compilerVersions.currentCompilerVersion,
            },
          },
        },
      });
      await markRunSkipped(run, currentRecurringEdit, mismatchReason);
      return { skipped: true, reason: "compiler_version_mismatch_requires_confirmation" };
    }

    const exclusiveLock = await acquireExclusiveShopWork({
      shop: currentRecurringEdit.shop,
      activity: "recurring_edit_execution",
      worker: "recurringEditExecutionService",
      queue: RECURRING_EDIT_EXECUTION_QUEUE,
      jobId: run.id,
      entityType: "recurringEditRun",
      entityId: run.id,
      executionId: run.id,
      namespace: LOCK_NS.WRITE_CATALOG,
    });

    if (!exclusiveLock.acquired) {
      return buildDeferredResult("shop_work_conflict", run.id, currentRecurringEdit.id);
    }

    exclusiveShopLockKey = exclusiveLock.lockKey;

    if (run.editHistoryId) {
      return {
        success: true,
        runId: run.id,
        editHistoryId: run.editHistoryId,
        reused: true,
      };
    }

    const claimed = await recurringEditRunRepository.updatePendingToProcessing(run.id);
    if (!claimed.count && run.status !== "PROCESSING") {
      return { skipped: true, reason: "run_not_claimed" };
    }

    const session = await getSession(currentRecurringEdit.shop);
    if (!session?.shop || session.shop !== currentRecurringEdit.shop) {
      throw new Error("Shop session not available for recurring edit execution");
    }

    const { status } = await getCurrentBulkOperationStatus(session);
    if (status === "RUNNING") {
      return buildDeferredResult("shopify_bulk_busy", run.id, currentRecurringEdit.id);
    }

    const service = new ProductBulkService(session);
    const body = buildRecurringEditHistoryBody(currentRecurringEdit);
    const baseHistory = await service._bulkOperationEdit(body, {
      planName: "Pro Monthly",
      isUnlimited: true,
      limit: Number.MAX_SAFE_INTEGER,
    }, {
      actor: buildActorContext({
        session,
        fallbackType: "SCHEDULE",
      }),
      entitlementSnapshot: buildEntitlementSnapshot({
        planName: "Pro Monthly",
        isUnlimited: true,
        limit: Number.MAX_SAFE_INTEGER,
      }),
    });

    const localizedTitle = await createMultiLanguage(currentRecurringEdit.title);
    const prepared = await prisma.$transaction(async (tx) => {
      const mergedBatch = {
        ...(baseHistory.batch && typeof baseHistory.batch === "object" ? baseHistory.batch : {}),
        filterAst: currentRecurringEdit.filterAst ?? null,
        filterParams: Array.isArray(currentRecurringEdit.filterParams)
          ? currentRecurringEdit.filterParams
          : [],
        targetGranularity: currentRecurringEdit.targetGranularity || "PRODUCT",
        targetingMode: "DYNAMIC_AT_RUN",
        freezeMode: "DYNAMIC_AT_RUN",
      };
      const editHistory = await tx.editHistory.create({
        data: {
          ...baseHistory,
          batch: mergedBatch,
          targetSnapshotCount: 0,
          totalItems: 0,
          targetMirrorBatchId: null,
          title: localizedTitle,
          type: "Recurring edit",
          isRecurring: true,
          recurringEditId: currentRecurringEdit.id,
          recurringRunId: run.id,
          triggerType: "RECURRING",
          executionState: OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
        },
      });

      await recurringEditRunRepository.updateById(run.id, {
        editHistoryId: editHistory.id,
        mirrorBatchId: null,
        filterAst: currentRecurringEdit.filterAst ?? null,
        normalizedFilterAst: currentRecurringEdit.normalizedFilterAst ?? null,
        targetingSnapshotMeta: {
          ...(currentRecurringEdit.targetingSnapshotMeta || {}),
          createdCompilerVersion:
            compilerVersions.createdCompilerVersion || currentRecurringEdit.targetingCompilerVersion || null,
          currentCompilerVersion: compilerVersions.currentCompilerVersion,
          source: "RECURRING",
          semantics: "DYNAMIC_AT_RUN",
          runId: run.id,
          recurringEditId: currentRecurringEdit.id,
          resolvedAt: null,
        },
        targetingMode: "DYNAMIC_AT_RUN",
        targetGranularity: currentRecurringEdit.targetGranularity || "PRODUCT",
        targetingCompilerVersion: compilerVersions.currentCompilerVersion,
        fieldRegistryVersion: currentRecurringEdit.fieldRegistryVersion || null,
        operatorRegistryVersion: currentRecurringEdit.operatorRegistryVersion || null,
        filterHash: currentRecurringEdit.filterHash || null,
        targetResolvedAt: null,
      }, tx);

      return {
        editHistoryId: editHistory.id,
        executionIdentity: editHistory.executionIdentity,
      };
    });

    await createEnqueueIntent({
      shop: currentRecurringEdit.shop,
      queueKey: ENQUEUE_QUEUE_KEYS.BULK_EDIT_PIPELINE,
      jobName: "target.freeze",
      payload: {
        historyId: prepared.editHistoryId,
        shop: currentRecurringEdit.shop,
        source: "recurring_edit_pipeline",
        executionId: prepared.executionIdentity || prepared.editHistoryId,
      },
      options: {},
      dedupeKey: `recurring-freeze:${prepared.editHistoryId}`,
    });
    const dispatchResult = await dispatchPendingEnqueueIntents({
      shop: currentRecurringEdit.shop,
      queueKey: ENQUEUE_QUEUE_KEYS.BULK_EDIT_PIPELINE,
      limit: 10,
    });
    if (dispatchResult.dispatched > 0) {
      await prisma.editHistory.updateMany({
        where: { id: prepared.editHistoryId, shop: currentRecurringEdit.shop },
        data: {
          executionState: OPERATION_LIFECYCLE_STATES.QUEUED,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            OPERATION_LIFECYCLE_STATES.QUEUED,
          ),
        },
      });
    }

    logger.info("Recurring edit execution queued", {
      shop: currentRecurringEdit.shop,
      runId: run.id,
      recurringEditId: currentRecurringEdit.id,
      editHistoryId: prepared.editHistoryId,
    });

    return {
      success: true,
      runId: run.id,
      editHistoryId: prepared.editHistoryId,
    };
  } catch (error) {
    await markRunFailed(run, recurringEdit, error.message || "Recurring edit execution failed").catch(() => {});
    await logWorkerError({
      shop: recurringEdit.shop,
      err: error,
      source: "RecurringEditExecutionService.executeRecurringEditRun",
    });
    throw error;
  } finally {
    await releaseExclusiveShopWork(exclusiveShopLockKey);
    await releaseShopLock(shopLock.key); // ✅ Redis release
  }
}

export async function finalizeRecurringRunFromHistory({
  historyId,
  shop = null,
  status,
  errorMessage = null,
}) {
  const history = await prisma.editHistory.findUnique({
    where: { id: historyId },
    select: {
      recurringRunId: true,
      recurringEditId: true,
      completedAt: true,
      status: true,
      shop: true,
    },
  });

  if (!history?.recurringRunId || !history?.recurringEditId) {
    return null;
  }
  if (shop && history?.shop && history.shop !== shop) {
    throw new Error("CROSS_SHOP_RECURRING_FINALIZE_BLOCKED");
  }

  const run = await recurringEditRunRepository.findById(history.recurringRunId);
  if (!run || isTerminalRunStatus(run.status)) {
    return run;
  }

  const completedAt = history.completedAt || new Date();
  const normalizedStatus =
    status === "SUCCESS" || history.status === "completed" ? "SUCCESS" : "FAILED";

  const transition = await recurringEditRunRepository.markProcessingFinished(
    history.recurringRunId,
    normalizedStatus,
    {
      completedAt,
      errorMessage:
        normalizedStatus === "FAILED"
          ? errorMessage || "Recurring run failed"
          : null,
    },
  );

  if (!transition.count) {
    return run.status;
  }

  await recurringEditRepository.updateByIdForShop({
    id: history.recurringEditId,
    shop: history.shop,
    data: {
      runCount: { increment: 1 },
      lastRunAt: completedAt,
      ...(normalizedStatus === "SUCCESS"
        ? { lastSuccessAt: completedAt, lastFailureReason: null }
        : {
            lastFailureAt: completedAt,
            lastFailureReason: errorMessage || "Recurring run failed",
          }),
    },
  });

  return normalizedStatus;
}
