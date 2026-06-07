import { connection } from "../config/redis.js";
import { recurringEditRepository } from "../repositories/recurringEditRepository.js";
import { recurringEditRunRepository } from "../repositories/recurringEditRunRepository.js";
import {
  createRecurringEditHistoryAndLinkRun,
  findHistoryForRecurringFinalize,
  markEditHistoryQueuedIfFrozen,
  tryTransactionAdvisoryLock,
  withRecurringExecutionTransaction,
} from "../repositories/recurringEditExecutionRepository.js";
import { computeRecurringEditNextRunAt } from "./recurringEditScheduleService.js";
import { getSession } from "../utils/sessionHandler.js";
import { logWorkerError } from "../utils/errorLogUtils.js";
import logger from "../utils/loggerUtils.js";
import { BulkEditCommandService } from "./bulkEdit/BulkEditCommandService.js";
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
import {
  createEnqueueIntent,
  dispatchPendingEnqueueIntents,
  ENQUEUE_QUEUE_KEYS,
} from "./operationEnqueueIntentService.js";
import {
  buildBulkTargetFreezeJobId,
} from "../utils/jobQueueUtils.js";
import {
  RECURRING_EDIT_EXECUTION_QUEUE,
  enqueueRecurringEditExecution,
} from "../queues/adapters/recurringEditQueueAdapter.js";
import {
  acquireRedisLock,
  releaseRedisLock,
} from "../utils/redisLockUtils.js";

// ✅ Keep advisory lock only for transactional use inside db.$transaction
// ✅ Redis locks for scheduler and shop — replaces pg_advisory_lock session locks
const SCHEDULER_LOCK_KEY = "lock:recurring-edit-scheduler";
const SCHEDULER_LOCK_TTL_MS = 55_000;

async function acquireSchedulerLock() {
  return acquireRedisLock({
    connection,
    key: SCHEDULER_LOCK_KEY,
    ttlMs: SCHEDULER_LOCK_TTL_MS,
  });
}

async function releaseSchedulerLock(lock) {
  if (!lock?.acquired) return;
  await releaseRedisLock({
    connection,
    key: lock.key,
    token: lock.token,
  }).catch(() => {});
}

async function acquireShopLock(shop) {
  const key = `lock:recurring-edit-shop:${shop}`;
  return acquireRedisLock({
    connection,
    key,
    ttlMs: 120_000,
  });
}

async function releaseShopLock(lock) {
  if (!lock?.acquired) return;
  await releaseRedisLock({
    connection,
    key: lock.key,
    token: lock.token,
  }).catch(() => {});
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
    recurringEdit.shop,
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
  const transition = await recurringEditRunRepository.markPendingSkipped(
    run.id,
    recurringEdit.shop,
    { errorMessage: reason },
  );

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

export async function enqueueRecurringEditExecutionJob({
  runId,
  shop,
  recurringEditId = null,
  scheduledFor = null,
}) {
  return enqueueRecurringEditExecution({
    runId,
    shop,
    recurringEditId,
    scheduledFor,
  });
}

export async function scheduleDueRecurringEditRuns({ shop, limit = 100 } = {}) {
  if (!shop) {
    throw new Error("RECURRING_EDIT_SCHEDULER_REQUIRES_SHOP");
  }
  // ✅ Redis lock instead of pg_advisory_lock
  const schedulerLock = await acquireSchedulerLock();
  if (!schedulerLock?.acquired) {
    return { scheduled: 0, skipped: 0, reason: "scheduler_locked" };
  }

  try {
    const now = new Date();
    const dueIds = await recurringEditRepository.findDueRecurringEditIdsForShop(shop, now, limit);
    let scheduled = 0;
    let skipped = 0;

    for (const { id } of dueIds) {
      try {
        const reservation = await withRecurringExecutionTransaction(async (tx) => {
          const locked = await tryTransactionAdvisoryLock(tx, `recurring-edit:${id}`);
          if (!locked) return null;

          const recurringEdit = await recurringEditRepository.findByIdForShop(id, shop, tx);
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
            shop,
            tx,
          );

          if (existingRun) {
            return {
              runId: existingRun.id,
              shop: recurringEdit.shop,
              recurringEditId: recurringEdit.id,
              scheduledFor,
            };
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

          return {
            runId: run.id,
            shop: recurringEdit.shop,
            recurringEditId: recurringEdit.id,
            scheduledFor,
          };
        });

        if (!reservation?.runId) {
          skipped += 1;
          continue;
        }

        await enqueueRecurringEditExecutionJob({
          runId: reservation.runId,
          shop: reservation.shop,
          recurringEditId: reservation.recurringEditId,
          scheduledFor: reservation.scheduledFor,
        });
        scheduled += 1;
      } catch (error) {
        if (error?.code === "P2002") {
          skipped += 1;
          continue;
        }

        await logWorkerError({
          shop,
          err: error,
          source: "RecurringEditExecutionService.scheduleDueRecurringEditRuns",
        });
        skipped += 1;
      }
    }

    return { scheduled, skipped, scanned: dueIds.length };
  } finally {
    await releaseSchedulerLock(schedulerLock);
  }
}

export async function executeRecurringEditRun(runId, shopFromJob = null) {
  if (!shopFromJob || !runId) {
    throw new Error("RECURRING_EDIT_RUN_REQUIRES_SHOP_AND_RUN_ID");
  }
  let run = await recurringEditRunRepository.findByIdWithRecurringEdit(runId, shopFromJob);
  if (!run) return { skipped: true, reason: "run_not_found" };

  if (isTerminalRunStatus(run.status)) {
    return { skipped: true, reason: "run_already_completed" };
  }

  const recurringEdit = run.recurringEdit;
  if (recurringEdit?.shop && recurringEdit.shop !== shopFromJob) {
    throw new Error("Cross-shop recurring edit execution blocked");
  }
  if (!isRunnableRecurringEdit(recurringEdit)) {
    await markRunSkipped(run, recurringEdit || { id: run.recurringEditId, shop: shopFromJob }, "Recurring edit is not active");
    return { skipped: true, reason: "recurring_edit_inactive" };
  }

  // ✅ Redis lock instead of pg_advisory_lock
  const shopLock = await acquireShopLock(recurringEdit.shop);
  if (!shopLock.acquired) {
    return buildDeferredResult("shop_execution_locked", run.id, recurringEdit.id);
  }

  let exclusiveShopLockKey = null;

  try {
    run = await recurringEditRunRepository.findByIdWithRecurringEdit(runId, shopFromJob);
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

    const claimed = await recurringEditRunRepository.updatePendingToProcessing(
      run.id,
      currentRecurringEdit.shop,
    );
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

    const commandService = new BulkEditCommandService(session);
    const body = buildRecurringEditHistoryBody(currentRecurringEdit);
    const baseHistory = await commandService.buildSystemEditHistoryData(body, {
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
    const prepared = await withRecurringExecutionTransaction(async (tx) =>
      createRecurringEditHistoryAndLinkRun({
        tx,
        baseHistory,
        currentRecurringEdit,
        runId: run.id,
        localizedTitle,
        compilerVersions,
      }),
    );

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
      options: {
        jobId: buildBulkTargetFreezeJobId({
          shop: currentRecurringEdit.shop,
          operationId: prepared.editHistoryId,
        }),
      },
      dedupeKey: `recurring-freeze:${prepared.editHistoryId}`,
    });
    const dispatchResult = await dispatchPendingEnqueueIntents({
      shop: currentRecurringEdit.shop,
      queueKey: ENQUEUE_QUEUE_KEYS.BULK_EDIT_PIPELINE,
      limit: 10,
    });
    if (dispatchResult.dispatched > 0) {
      const queued = await markEditHistoryQueuedIfFrozen(
        prepared.editHistoryId,
        currentRecurringEdit.shop,
      );
      if (queued.count !== 1) {
        throw new Error("RECURRING_EDIT_STATE_TRANSITION_REJECTED_QUEUED");
      }
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
    await releaseShopLock(shopLock);
  }
}

export async function finalizeRecurringRunFromHistory({
  historyId,
  shop = null,
  status,
  errorMessage = null,
}) {
  if (!shop || !historyId) {
    throw new Error("RECURRING_FINALIZE_REQUIRES_SHOP_AND_HISTORY_ID");
  }
  const history = await findHistoryForRecurringFinalize(historyId, shop);

  if (history?.shop && history.shop !== shop) {
    throw new Error("CROSS_SHOP_RECURRING_FINALIZE_BLOCKED");
  }
  if (!history?.recurringRunId || !history?.recurringEditId) {
    return null;
  }
  const run = await recurringEditRunRepository.findById(history.recurringRunId, history.shop);
  if (!run || isTerminalRunStatus(run.status)) {
    return run;
  }

  const completedAt = history.completedAt || new Date();
  const normalizedStatus =
    status === "SUCCESS" || history.status === "completed" ? "SUCCESS" : "FAILED";

  const transition = await recurringEditRunRepository.markProcessingFinished(
    history.recurringRunId,
    history.shop,
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
