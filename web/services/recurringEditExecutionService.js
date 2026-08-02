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
import ProductBulkService from "./productService/productBulkEditService.js";
import { createMultiLanguage } from "../utils/googleTranslator.js";
import { loadAuthoritativeSubscriptionForShop } from "./subscriptionAuthorityService.js";
import { hasRecurringEditAccess } from "./recurringEditPlanService.js";
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
  recurringEditRunJobId,
} from "../utils/jobQueueUtils.js";
import { db } from "../repositories/repositoryDb.js";
import {
  RECURRING_EDIT_EXECUTION_QUEUE,
  enqueueRecurringEditExecution,
} from "../queues/adapters/recurringEditQueueAdapter.js";
import {
  acquireRedisLock,
  releaseRedisLock,
} from "../utils/redisLockUtils.js";
import {
  advanceRecurringEditScheduleClaim,
  claimDueRecurringEditSchedules,
} from "../repositories/scheduleStateRepository.js";

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
  }).catch(() => ({ acquired: true, key, token: "fallback" }));
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

function recurringDefinitionFromRun(run) {
  if (!run?.definitionSnapshot) {
    if (run?.legacyRevisionUnknown || run?.definitionRevision == null) {
      return run?.recurringEdit || null;
    }
    throw new Error("RECURRING_EDIT_RUN_REVISION_REQUIRED");
  }
  const snapshot = run.definitionSnapshot.definitionSnapshot;
  return {
    ...run.recurringEdit,
    ...(snapshot.schedulePolicy || {}),
    ...(snapshot.filter || {}),
    rules: snapshot.rulesActions?.rules || [],
  };
}

function isTerminalRunStatus(status) {
  return ["SUCCESS", "FAILED", "SKIPPED"].includes(status);
}

export async function createRunFinalizationIntent({
  tx,
  shop,
  sourceId,
  sourceVersion = 1,
  targetRunId,
  terminalStatus,
}) {
  if (!tx || !shop || !sourceId || !targetRunId || !terminalStatus) {
    throw new Error("RUN_FINALIZATION_INTENT_SCOPE_REQUIRED");
  }
  return tx.runFinalizationIntent.upsert({
    where: {
      shop_kind_sourceId_sourceVersion_targetRunId: {
        shop,
        kind: "RECURRING_EDIT_HISTORY_FINALIZATION",
        sourceId,
        sourceVersion: Number(sourceVersion),
        targetRunId,
      },
    },
    create: {
      shop,
      kind: "RECURRING_EDIT_HISTORY_FINALIZATION",
      sourceId,
      sourceVersion: Number(sourceVersion),
      targetRunId,
      terminalStatus,
    },
    update: {},
  });
}

function isRunnableRecurringEdit(recurringEdit) {
  return recurringEdit && !recurringEdit.isDeleted && recurringEdit.status === "ACTIVE";
}

function buildDeferredResult(reason, recurringEditRunId, recurringEditId = null) {
  return {
    success: true,
    deferred: true,
    reason,
    recurringEditRunId,
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
    rawFilterInput: [],
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
    versionsMatch: Boolean(created) && created === current,
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
      runCount: { increment: 1n },
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
      runCount: { increment: 1n },
      lastRunAt: new Date(),
    },
  });

  return reason;
}

export async function enqueueRecurringEditExecutionJob({
  recurringEditRunId,
  shop,
  recurringEditId = null,
  scheduledFor = null,
  delay = 0,
  jobId = null,
}) {
  return enqueueRecurringEditExecution({
    recurringEditRunId,
    shop,
    recurringEditId,
    scheduledFor,
    delay,
    jobId,
  });
}

export async function scheduleDueRecurringEditRuns({ limit = 100 } = {}) {
  // ✅ Redis lock instead of pg_advisory_lock
  const schedulerLock = await acquireSchedulerLock();
  if (!schedulerLock?.acquired) {
    return { scheduled: 0, skipped: 0, reason: "scheduler_locked" };
  }

  try {
    const now = new Date();
    const claimOwner = `recurring-scheduler:${schedulerLock.token}`;
    const dueClaims = await claimDueRecurringEditSchedules({
      now,
      ownerId: claimOwner,
      leaseUntil: new Date(now.getTime() + SCHEDULER_LOCK_TTL_MS),
      limit,
    });
    let scheduled = 0;
    let skipped = 0;

    for (const claim of dueClaims) {
      try {
        const reservation = await withRecurringExecutionTransaction(async (tx) => {
          const recurringEdit = await recurringEditRepository.findByIdForShop(
            claim.recurringEditId,
            claim.shop,
            tx,
          );
          if (
            !isRunnableRecurringEdit(recurringEdit) ||
            !claim.nextRunAt ||
            claim.nextRunAt > now ||
            recurringEdit.revision !== claim.definitionRevision
          ) {
            return null;
          }

          const revision = await tx.recurringEditRevision.findUnique({
            where: {
              shop_recurringEditId_revision: {
                shop: claim.shop,
                recurringEditId: claim.recurringEditId,
                revision: claim.definitionRevision,
              },
            },
          });
          if (!revision) throw new Error("RECURRING_EDIT_REVISION_SNAPSHOT_MISSING");
          const snapshot = revision.definitionSnapshot;
          const immutableDefinition = {
            ...recurringEdit,
            ...(snapshot.schedulePolicy || {}),
            ...(snapshot.filter || {}),
            rules: snapshot.rulesActions?.rules || [],
          };

          const scheduledFor = claim.nextRunAt;
          const executionDedupeKey = buildExecutionKey(recurringEdit.id, scheduledFor);
          const existingRun = await recurringEditRunRepository.findByExecutionKey(
            executionDedupeKey,
            recurringEdit.shop,
            tx,
          );

          if (existingRun) {
            return existingRun;
          }

          const run = await recurringEditRunRepository.create(
            {
              recurringEditId: recurringEdit.id,
              shop: recurringEdit.shop,
              scheduledFor,
              status: "PENDING",
              executionDedupeKey,
              definitionRevision: revision.revision,
              configurationHash: revision.configurationHash,
              filterSnapshotHash: revision.filterSnapshotHash,
              selectedFieldsSnapshotHash: revision.selectedFieldsSnapshotHash,
              rulesActionsSnapshotHash: revision.rulesActionsSnapshotHash,
              schedulePolicySnapshotHash: revision.schedulePolicySnapshotHash,
              legacyRevisionUnknown: false,
            },
            tx,
          );

          const nextRunAt = computeRecurringEditNextRunAt(
            immutableDefinition,
            new Date(scheduledFor.getTime() + 1000),
          );

          const advanced = await advanceRecurringEditScheduleClaim({ claim, nextRunAt }, tx);
          if (advanced.count !== 1) throw new Error("RECURRING_SCHEDULE_CLAIM_FENCE_LOST");
          await tx.recurringEdit.updateMany({
            where: { id: recurringEdit.id, shop: recurringEdit.shop, revision: claim.definitionRevision },
            data: { nextRunAt, status: nextRunAt ? "ACTIVE" : "COMPLETED" },
          });

          await createEnqueueIntent({
            tx,
            shop: recurringEdit.shop,
            queueRoutingKey: "RECURRING_EDIT_RUN",
            queueJobName: "recurring-edit-execution",
            payload: {
              recurringEditRunId: run.id,
              recurringEditId: recurringEdit.id,
              shop: recurringEdit.shop,
              scheduledFor,
            },
            options: {
              jobId: recurringEditRunJobId({
                shop: recurringEdit.shop,
                recurringEditId: recurringEdit.id,
                scheduledFor,
              }),
            },
            dispatchDedupeKey: `recurring-edit-run:${run.id}`,
          });

          return run;
        });

        if (!reservation?.id) {
          skipped += 1;
          continue;
        }

        scheduled += 1;
      } catch (error) {
        if (error?.code === "P2002") {
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

    return { scheduled, skipped, scanned: dueClaims.length };
  } finally {
    await releaseSchedulerLock(schedulerLock);
  }
}

export async function executeRecurringEditRun(recurringEditRunId, shopFromJob = null) {
  if (!shopFromJob) throw new Error("SHOP_REQUIRED_FOR_RECURRING_RUN_EXECUTION");
  let run = await recurringEditRunRepository.findByIdWithRecurringEdit(recurringEditRunId, shopFromJob);
  if (!run) return { skipped: true, reason: "run_not_found" };

  if (isTerminalRunStatus(run.status)) {
    return { skipped: true, reason: "run_already_completed" };
  }

  const recurringEdit = recurringDefinitionFromRun(run);
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
    run = await recurringEditRunRepository.findByIdWithRecurringEdit(recurringEditRunId, shopFromJob);
    if (!run || isTerminalRunStatus(run.status)) {
      return { skipped: true, reason: "run_not_actionable" };
    }

    const currentRecurringEdit = recurringDefinitionFromRun(run);
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
        expectedRevision: currentRecurringEdit.revision,
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
        recurringEditRunId: run.id,
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

    const authoritativeSubscription =
      await loadAuthoritativeSubscriptionForShop(currentRecurringEdit.shop);

    if (!hasRecurringEditAccess(authoritativeSubscription)) {
      await withRecurringExecutionTransaction(async (tx) => {
        await tx.recurringEditRun.updateMany({
          where: {
            id: run.id,
            shop: currentRecurringEdit.shop,
            status: "PENDING",
          },
          data: {
            status: "SKIPPED",
            completedAt: new Date(),
            errorMessage: "RECURRING_EDIT_ENTITLEMENT_REVOKED",
            entitlementPlanKey: authoritativeSubscription.planKey,
            entitlementStatus: authoritativeSubscription.status,
            entitlementCheckedAt: new Date(),
          },
        });

        await recurringEditRepository.updateByIdForShop({
          id: currentRecurringEdit.id,
          shop: currentRecurringEdit.shop,
          expectedRevision: currentRecurringEdit.revision,
          data: {
            status: "PAUSED",
            nextRunAt: null,
            lastFailureReason: "RECURRING_EDIT_ENTITLEMENT_REVOKED",
          },
        }, tx);
      });

      return { skipped: true, reason: "entitlement_revoked" };
    }

    const service = new ProductBulkService(session);
    const body = buildRecurringEditHistoryBody(currentRecurringEdit);
    const baseHistory = await service._bulkOperationEdit(
      body,
      authoritativeSubscription,
      {
        actor: buildActorContext({
          session,
          fallbackType: "SCHEDULE",
        }),
        entitlementSnapshot:
          buildEntitlementSnapshot(authoritativeSubscription),
      },
    );

    const localizedTitle = await createMultiLanguage(currentRecurringEdit.title);
    const prepared = await withRecurringExecutionTransaction(async (tx) =>
      createRecurringEditHistoryAndLinkRun({
        tx,
        baseHistory,
        currentRecurringEdit,
        recurringEditRunId: run.id,
        localizedTitle,
        compilerVersions,
      }),
    );

    await createEnqueueIntent({
      shop: currentRecurringEdit.shop,
      queueRoutingKey: ENQUEUE_QUEUE_KEYS.BULK_EDIT_PIPELINE,
      queueJobName: "target.freeze",
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
      dispatchDedupeKey: `recurring-freeze:${prepared.editHistoryId}`,
    });
    const dispatchResult = await dispatchPendingEnqueueIntents({
      shop: currentRecurringEdit.shop,
      queueRoutingKey: ENQUEUE_QUEUE_KEYS.BULK_EDIT_PIPELINE,
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
      recurringEditRunId: run.id,
      recurringEditId: currentRecurringEdit.id,
      editHistoryId: prepared.editHistoryId,
    });

    return {
      success: true,
      recurringEditRunId: run.id,
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
  const history = await findHistoryForRecurringFinalize(historyId);

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
    status === "SUCCESS" || history.statusNormalized === "COMPLETED" ? "SUCCESS" : "FAILED";

  return db.$transaction(async (tx) => {
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
      tx,
    );

    if (!transition.count) return run.status;

    await createRunFinalizationIntent({
      tx,
      shop: history.shop,
      sourceId: history.id,
      sourceVersion: Number(history.stateVersion || 1),
      targetRunId: history.recurringRunId,
      terminalStatus: normalizedStatus,
    });
    await recurringEditRepository.updateByIdForShop({
      id: history.recurringEditId,
      shop: history.shop,
      data: {
        runCount: { increment: 1n },
        lastRunAt: completedAt,
        ...(normalizedStatus === "SUCCESS"
          ? { lastSuccessAt: completedAt, lastFailureReason: null }
          : {
              lastFailureAt: completedAt,
              lastFailureReason: errorMessage || "Recurring run failed",
            }),
      },
    }, tx);
    return normalizedStatus;
  });
}

export async function recoverLegacyPendingRecurringEditRuns({ limit = 50, dbClient = null } = {}) {
  const database = dbClient || db;
  const pendingRuns = await database.recurringEditRun.findMany({
    where: {
      status: "PENDING",
    },
    take: Math.min(limit, 100),
    orderBy: { createdAt: "asc" },
  });

  let recovered = 0;
  for (const run of pendingRuns) {
    const dedupeKey = `recurring-edit-run:${run.id}`;
    await database.$transaction(async (tx) => {
      await createEnqueueIntent({
        tx,
        shop: run.shop,
        queueRoutingKey: "RECURRING_EDIT_RUN",
        queueJobName: "recurring-edit-execution",
        payload: {
          recurringEditRunId: run.id,
          recurringEditId: run.recurringEditId,
          shop: run.shop,
          scheduledFor: run.scheduledFor,
        },
        options: {
          jobId: recurringEditRunJobId({
            shop: run.shop,
            recurringEditId: run.recurringEditId,
            scheduledFor: run.scheduledFor,
          }),
        },
        dispatchDedupeKey: dedupeKey,
      });
    });
    recovered++;
  }

  return { recovered };
}

export async function deferRecurringRun(run, reason, delayMs = 60_000) {
  const nextAttemptAt = new Date(Date.now() + delayMs);
  const nextRetryCount = (run.retryCount || 0) + 1;

  await recurringEditRunRepository.markRetryWait(run.id, {
    reason,
    nextAttemptAt,
    retryCount: nextRetryCount,
  });

  await createEnqueueIntent({
    shop: run.shop,
    queueRoutingKey: ENQUEUE_QUEUE_KEYS.RECURRING_EDIT_RUN,
    queueJobName: "recurring-run-retry",
    dispatchDedupeKey: `recurring-run-retry:${run.id}:${nextRetryCount}`,
    payload: { recurringEditRunId: run.id, shop: run.shop },
    options: { delay: delayMs },
  });

  return { success: true, deferred: true, reason };
}
