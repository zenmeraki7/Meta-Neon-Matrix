import { Prisma } from "../repositories/prismaTypes.js";
import { connection } from "../config/redis.js";
import { scheduledExportRepository } from "../repositories/scheduledExportRepository.js";
import { scheduledExportRunRepository } from "../repositories/scheduledExportRunRepository.js";
import {
  createScheduledExportHistory,
  createScheduledExportJob,
  findExportHistoryByScheduledTask,
  findExportJobById,
  findExportJobByScheduledRun,
  findExportJobForRunFinalize,
  markExportJobQueued,
  markExportJobTargetFrozen,
  tryAdvisoryLockTx,
  withScheduledExportExecutionTransaction,
} from "../repositories/scheduledExportExecutionRepository.js";
import { computeScheduledExportNextRunAt } from "./scheduledExportScheduleService.js";
import {
  getScheduledExportPlanContext,
  hasScheduledExportAccess,
} from "./scheduledExportPlanService.js";
import { addbulkExportJob } from "../Jobs/Queues/bulkExportJob.js";
import logger from "../utils/loggerUtils.js";
import { logWorkerError } from "../utils/errorLogUtils.js";
import {
  acquireExclusiveShopWork,
  LOCK_NS,
  releaseExclusiveShopWork,
} from "./shopWorkLeaseService.js";
import {
  buildActorContext,
  buildEntitlementSnapshot,
} from "../utils/operationContextUtils.js";
import { EXPORT_EXECUTION_STATES } from "./exportExecutionStateService.js";
import {
} from "../utils/jobQueueUtils.js";
import {
  SCHEDULED_EXPORT_EXECUTION_QUEUE,
  enqueueScheduledExportExecution,
} from "../queues/adapters/scheduledExportQueueAdapter.js";
import { TargetingEngineService } from "./targeting/TargetingEngineService.js";
import {
  acquireRedisLock,
  releaseRedisLock,
  renewRedisLock,
} from "../utils/redisLockUtils.js";

function buildExecutionKey(scheduledExportId, scheduledFor) {
  return `${scheduledExportId}:${new Date(scheduledFor).toISOString()}`;
}

function isTerminalRunStatus(status) {
  return ["SUCCESS", "FAILED", "SKIPPED"].includes(status);
}

async function markRunFailed(run, scheduledExport, errorMessage) {
  const transition = await scheduledExportRunRepository.markProcessingFinished(
    run.id,
    "FAILED",
    {
      errorMessage,
    },
  );

  if (!transition.count) {
    return null;
  }

  await scheduledExportRepository.updateByIdForShop({
    id: scheduledExport.id,
    shop: scheduledExport.shop,
    data: {
      runCount: { increment: 1 },
      lastRunAt: new Date(),
      lastFailureAt: new Date(),
      lastFailureReason: errorMessage,
    },
  });

  return errorMessage;
}

async function markRunSkipped(run, scheduledExport, reason) {
  const transition = await scheduledExportRunRepository.markPendingSkipped(run.id, {
    errorMessage: reason,
  });

  if (!transition.count) {
    return null;
  }

  await scheduledExportRepository.updateByIdForShop({
    id: scheduledExport.id,
    shop: scheduledExport.shop,
    data: {
      runCount: { increment: 1 },
      lastRunAt: new Date(),
    },
  });

  return reason;
}

export async function enqueueScheduledExportExecutionJob({
  scheduledExportRunId,
  shop,
  scheduledExportId = null,
  scheduledFor = null,
  delay = 0,
  jobId = null,
}) {
  return enqueueScheduledExportExecution({
    scheduledExportRunId,
    shop,
    scheduledExportId,
    scheduledFor,
    delay,
    jobId,
  });
}

async function deferScheduledExportRun(scheduledExportRunId, shop, reason, delay = 60_000) {
  await enqueueScheduledExportExecutionJob({
    scheduledExportRunId,
    shop,
    delay,
  });

  return {
    success: true,
    deferred: true,
    reason,
    scheduledExportRunId,
  };
}
const SCHEDULER_LOCK_TTL_MS = 55_000;
const SCHEDULER_LOCK_KEY = "lock:scheduled-export-scheduler";

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
const SHOP_LOCK_TTL_MS = 120_000;
const SHOP_LOCK_RENEW_INTERVAL_MS = 60_000;
async function acquireShopLock(shop) {
  const key = `lock:scheduled-export-shop:${shop}`;
  return acquireRedisLock({
    connection,
    key,
    ttlMs: SHOP_LOCK_TTL_MS,
  });
}

async function releaseShopLock(lock) {
  if (!lock?.acquired) return;
  await releaseRedisLock({
    connection,
    key: lock.key,
    token: lock.token,
  }).catch(() => { });
}
export async function scheduleDueScheduledExportRuns({ limit = 100 } = {}) {
  // console.log("⏰ Scheduled export scheduler triggered");
  const schedulerLock = await acquireSchedulerLock();
  if (!schedulerLock?.acquired) {
    return { scheduled: 0, skipped: 0, reason: "scheduler_locked" };
  }
  let renewInterval;
  try {
    renewInterval = setInterval(async () => {
      await renewRedisLock({
        connection,
        key: schedulerLock.key,
        token: schedulerLock.token,
        ttlMs: SCHEDULER_LOCK_TTL_MS,
      });
    }, 30_000);
    const now = new Date();
    // console.log("🕒 Current time:", now.toISOString());

    const dueIds = await scheduledExportRepository.findDueScheduledExportIds(now, limit);
    // console.log("📦 Due Scheduled Exports:", dueIds);

    let scheduled = 0;
    let skipped = 0;

    for (const { id } of dueIds) {
      try {
        console.log("🔁 Processing scheduledExportId:", id);
        const reservation = await withScheduledExportExecutionTransaction(async (tx) => {
          const locked = await tryAdvisoryLockTx(tx, `scheduled-export:${id}`);
          if (!locked) {
            return null;
          }

          const scheduledExport = await scheduledExportRepository.findById(id, tx);
          if (
            !scheduledExport ||
            scheduledExport.isDeleted ||
            scheduledExport.status !== "ACTIVE" ||
            !scheduledExport.nextRunAt ||
            scheduledExport.nextRunAt > now
          ) {
            return null;
          }

          const scheduledFor = scheduledExport.nextRunAt;
          const executionDedupeKey = buildExecutionKey(id, scheduledFor);
          const existingRun = await scheduledExportRunRepository.findByExecutionKey(
            executionDedupeKey,
            scheduledExport.shop,
            tx,
          );

          if (existingRun) {
            return {
              scheduledExportRunId: existingRun.id,
              shop: scheduledExport.shop,
              scheduledExportId: scheduledExport.id,
              scheduledFor,
            };
          }

          const run = await scheduledExportRunRepository.create(
            {
              scheduledExportId: scheduledExport.id,
              shop: scheduledExport.shop,
              scheduledFor,
              status: "PENDING",
              executionDedupeKey,
            },
            tx,
          );

          const nextRunAt = computeScheduledExportNextRunAt(
            scheduledExport,
            new Date(scheduledFor.getTime() + 1000),
          );

          await scheduledExportRepository.updateByIdForShop(
            {
              id: scheduledExport.id,
              shop: scheduledExport.shop,
              data: {
                nextRunAt,
                status: nextRunAt ? "ACTIVE" : "COMPLETED",
              },
            },
            tx,
          );

          return {
            scheduledExportRunId: run.id,
            shop: scheduledExport.shop,
            scheduledExportId: scheduledExport.id,
            scheduledFor,
          };
        }, { timeout: 15_000 });

        if (!reservation?.scheduledExportRunId) {
          skipped += 1;
          continue;
        }

        await enqueueScheduledExportExecutionJob({
          scheduledExportRunId: reservation.scheduledExportRunId,
          shop: reservation.shop,
          scheduledExportId: reservation.scheduledExportId,
          scheduledFor: reservation.scheduledFor,
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
          source: "ScheduledExportExecutionService.scheduleDueScheduledExportRuns",
        });
        skipped += 1;
      }
    }

    return {
      scheduled,
      skipped,
      scanned: dueIds.length,
    };
  } finally {
    clearInterval(renewInterval);
    await releaseSchedulerLock(schedulerLock);
  }
}

export async function executeScheduledExportRun(scheduledExportRunId, shopFromJob = null) {
  let run = await scheduledExportRunRepository.findByIdWithScheduledExport(scheduledExportRunId);
  if (!run) {
    return { skipped: true, reason: "run_not_found" };
  }

  if (isTerminalRunStatus(run.status)) {
    return { skipped: true, reason: "run_already_completed" };
  }

  const scheduledExport = run.scheduledExport;
  if (shopFromJob && scheduledExport?.shop && scheduledExport.shop !== shopFromJob) {
    throw new Error("Cross-shop scheduled export execution blocked");
  }
  if (
    !scheduledExport ||
    scheduledExport.isDeleted ||
    ["PAUSED", "CANCELLED", "FAILED"].includes(scheduledExport.status)
  ) {
    await markRunSkipped(run, scheduledExport || { id: run.scheduledExportId }, "Scheduled export is not active");
    return { skipped: true, reason: "scheduled_export_inactive" };
  }

  const planContext = await getScheduledExportPlanContext(scheduledExport.shop);
  if (!hasScheduledExportAccess(planContext)) {
    await markRunSkipped(run, scheduledExport, "Shop is not eligible for scheduled exports");
    return { skipped: true, reason: "plan_ineligible" };
  }

  // ✅ Redis lock instead of pg_advisory_lock
  const shopLock = await acquireShopLock(scheduledExport.shop);
  if (!shopLock.acquired) {
    return deferScheduledExportRun(
      run.id,
      scheduledExport.shop,
      "shop_execution_locked",
    );
  }
  let shopRenewInterval = null;
shopRenewInterval = setInterval(async () => {
  try {
    await renewRedisLock({
      connection,
      key: shopLock.key,
      token: shopLock.token,
      ttlMs: SHOP_LOCK_TTL_MS,
    });
  } catch (err) {
    logger.error("Failed to renew shop lock", {
      shop: scheduledExport.shop,
      scheduledExportRunId: run.id,
      error: err.message,
    });
  }
}, SHOP_LOCK_RENEW_INTERVAL_MS);
  let exclusiveShopLockKey = null;

  try {
    run = await scheduledExportRunRepository.findByIdWithScheduledExport(scheduledExportRunId);
    if (!run || isTerminalRunStatus(run.status)) {
      return { skipped: true, reason: "run_not_actionable" };
    }

    const exclusiveLock = await acquireExclusiveShopWork({
      shop: scheduledExport.shop,
      activity: "scheduled_export_execution",
      worker: "scheduledExportExecutionService",
      queue: SCHEDULED_EXPORT_EXECUTION_QUEUE,
      jobId: run.id,
      entityType: "scheduledExportRun",
      entityId: run.id,
      executionId: run.id,
      namespace: LOCK_NS.WRITE_CATALOG,
    });

    if (!exclusiveLock.acquired) {
      return deferScheduledExportRun(
        run.id,
        scheduledExport.shop,
        "shop_work_conflict",
      );
    }

    exclusiveShopLockKey = exclusiveLock.lockKey;

    if (run.exportJobId) {
      return {
        success: true,
        scheduledExportRunId: run.id,
        exportJobId: run.exportJobId,
        reused: true,
      };
    }
    const existingExportJob = await findExportJobByScheduledRun(scheduledExport.shop, run.id);
    if (existingExportJob?.id) {
      await scheduledExportRunRepository.updateById(run.id, {
        exportJobId: existingExportJob.id,
      });
      return {
        success: true,
        scheduledExportRunId: run.id,
        exportJobId: existingExportJob.id,
        reused: true,
      };
    }

    const claimed = await scheduledExportRunRepository.updateProcessingState(run.id);
    if (!claimed.count && run.status !== "PROCESSING") {
      return { skipped: true, reason: "run_not_claimed" };
    }
    const prepared = await withScheduledExportExecutionTransaction(async (tx) => {
      const locked = await tryAdvisoryLockTx(tx, `scheduled-export-run:${run.id}`);
      if (!locked) {
        return null;
      }

      const currentRun = await scheduledExportRunRepository.findByIdWithScheduledExport(run.id, tx);
      if (!currentRun || isTerminalRunStatus(currentRun.status)) {
        return null;
      }

      if (currentRun.exportJobId) {
        const existingJob = await findExportJobById(currentRun.exportJobId, tx);
        return existingJob
          ? { exportJob: existingJob, frozenCount: Number(existingJob.targetSnapshotCount || 0), reused: true }
          : null;
      }
      const createdExportJob = await createScheduledExportJob({
        data: {
          shop: currentRun.shop,
          generatedFilename: currentRun.scheduledExport.generatedFilename,
          selectedFieldKeys: currentRun.scheduledExport.selectedFieldKeys,
          legacyFilterQuery: "{}",
          status: "PENDING",
          executionState: EXPORT_EXECUTION_STATES.PLANNED,
          exportType: "Scheduled export",
          isScheduled: true,
          scheduledExportId: currentRun.scheduledExport.id,
          scheduledExportRunId: currentRun.id,
          triggerType: "SCHEDULED",
          entitlementSnapshot: buildEntitlementSnapshot({
            planName: "Pro Monthly",
            isUnlimited: true,
            limit: Number.MAX_SAFE_INTEGER,
          }),
          ...buildActorContext({
            fallbackType: "SCHEDULE",
          }),
        },
      }, tx);

      await scheduledExportRunRepository.updateById(
        currentRun.id,
        {
          exportJobId: createdExportJob.id,
        },
        tx,
      );

      const resolvedTarget = await TargetingEngineService.resolveAndFreezeExportTargets({
        shop: createdExportJob.shop,
        source: "EXPORT",
        targetResourceType: "PRODUCT",
        targetGranularity: currentRun.scheduledExport.targetGranularity || "PRODUCT",
        filterAst: currentRun.scheduledExport.filterAst ?? null,
        legacyFilterParams: Array.isArray(currentRun.scheduledExport.rawFilterInput)
          ? currentRun.scheduledExport.rawFilterInput
          : [],
        ownerType: "EXPORT_JOB",
        ownerId: createdExportJob.id,
        mutationIntent: {
          operationType: "SCHEDULED_EXPORT",
          mutationType: "CSV_EXPORT",
          mutationPayload: {
            selectedFieldKeys: createdExportJob.selectedFieldKeys || [],
            scheduledExportId: currentRun.scheduledExport.id,
            scheduledExportRunId: currentRun.id,
          },
          targetGranularity: currentRun.scheduledExport.targetGranularity || "PRODUCT",
        },
        queryParams: { cursor: null, limit: 20 },
        sampleLimit: 20,
        targetFreezeModeOverride: "DYNAMIC_AT_RUN",
        targetingSnapshotMetaOverride: {
          source: "EXPORT",
          semantics: "DYNAMIC_AT_RUN",
          scheduledExportRunId: currentRun.id,
          scheduledExportId: currentRun.scheduledExport.id,
        },
        db: tx,
      });
      const frozenCount = Number(resolvedTarget.frozenCount || 0);

      await scheduledExportRunRepository.updateById(currentRun.id, {
        targetProductMirrorBatchId: resolvedTarget.mirrorBatchId,
        filterAst: resolvedTarget.filterAst,
        normalizedFilterAst: resolvedTarget.normalizedFilterAst,
        targetingSnapshotMeta: {
          astVersion: resolvedTarget.versions.filterAstVersion,
          compilerVersion: resolvedTarget.versions.targetingCompilerVersion,
          fieldRegistryVersion: resolvedTarget.versions.fieldRegistryVersion,
          operatorRegistryVersion: resolvedTarget.versions.operatorRegistryVersion,
          targetGranularity: resolvedTarget.targetGranularity,
          shop: createdExportJob.shop,
          mirrorBatchId: resolvedTarget.mirrorBatchId,
          targetCount: frozenCount,
          normalizedFilterHash: resolvedTarget.normalizedFilterHash,
          targetSetHash: resolvedTarget.targetSetHash || null,
          normalizedAst: resolvedTarget.normalizedFilterAst,
          source: "EXPORT",
          semantics: "DYNAMIC_AT_RUN",
          scheduledExportRunId: currentRun.id,
          scheduledExportId: currentRun.scheduledExport.id,
          resolvedAt: new Date(),
        },
        targetFreezeMode: "DYNAMIC_AT_RUN",
        targetGranularity: resolvedTarget.targetGranularity,
        targetingCompilerVersion: resolvedTarget.versions.targetingCompilerVersion,
        fieldRegistryVersion: resolvedTarget.versions.fieldRegistryVersion,
        operatorRegistryVersion: resolvedTarget.versions.operatorRegistryVersion,
        normalizedFilterHash: resolvedTarget.normalizedFilterHash,
        targetResolvedAt: new Date(),
      }, tx);

      const targetFrozenSet = await markExportJobTargetFrozen({
        exportJobId: createdExportJob.id,
        shop: createdExportJob.shop,
        expectedExecutionState: EXPORT_EXECUTION_STATES.PLANNED,
        frozenCount,
      }, tx);
      if (targetFrozenSet.count !== 1) {
        throw new Error("SCHEDULED_EXPORT_STATE_TRANSITION_REJECTED_TARGET_FROZEN");
      }

      return { exportJob: createdExportJob, frozenCount, reused: false };
    }, { timeout: 15_000 });

    const exportJob = prepared?.exportJob;
    if (!exportJob?.id) {
      return {
        skipped: true,
        reason: "export_job_not_created",
      };
    }

    await addbulkExportJob({
      exportJobId: exportJob.id,
      shop: exportJob.shop,
      selectedFieldKeys: exportJob.selectedFieldKeys,
      source: "scheduled_export",
      executionId: exportJob.id,
    });
    const queued = await markExportJobQueued({
      exportJobId: exportJob.id,
      shop: exportJob.shop,
      expectedExecutionState: EXPORT_EXECUTION_STATES.PLANNED,
      queuedExecutionState: EXPORT_EXECUTION_STATES.QUEUED,
      executionStateNormalized: null,
    });
    if (queued.count !== 1) {
      throw new Error("SCHEDULED_EXPORT_STATE_TRANSITION_REJECTED_QUEUED");
    }

    logger.info("Scheduled export execution queued", {
      shop: exportJob.shop,
      scheduledExportRunId: run.id,
      scheduledExportId: scheduledExport.id,
      exportJobId: exportJob.id,
    });

    return {
      success: true,
      scheduledExportRunId: run.id,
      exportJobId: exportJob.id,
    };
  } catch (error) {
    await markRunFailed(run, scheduledExport, error.message || "Scheduled export execution failed").catch(() => { });
    await logWorkerError({
      shop: scheduledExport.shop,
      err: error,
      source: "ScheduledExportExecutionService.executeScheduledExportRun",
    });
    throw error;
  } finally {
  if (shopRenewInterval) {
    clearInterval(shopRenewInterval);
  }

  await releaseExclusiveShopWork(exclusiveShopLockKey);

  await releaseShopLock(shopLock);
}
}

export async function finalizeScheduledExportRunFromExportJob({
  exportJobId,
  shop = null,
  status,
  errorMessage = null,
}) {
  const exportJob = await findExportJobForRunFinalize(exportJobId);

  if (!exportJob?.scheduledExportId || !exportJob?.scheduledExportRunId) {
    return null;
  }
  if (shop && exportJob.shop !== shop) {
    throw new Error("CROSS_SHOP_SCHEDULED_EXPORT_FINALIZE_BLOCKED");
  }

  const run = await scheduledExportRunRepository.findById(exportJob.scheduledExportRunId);
  if (!run || isTerminalRunStatus(run.status)) {
    return run;
  }

  const completedAt = exportJob.completedAt || new Date();
  const normalizedStatus =
    status === "SUCCESS" || exportJob.status === "COMPLETED" ? "SUCCESS" : "FAILED";

  const transition = await scheduledExportRunRepository.markProcessingFinished(
    exportJob.scheduledExportRunId,
    normalizedStatus,
    {
      completedAt,
      errorMessage:
        normalizedStatus === "FAILED"
          ? errorMessage || exportJob.error || "Scheduled export run failed"
          : null,
      downloadUrl: normalizedStatus === "SUCCESS" ? exportJob.downloadUrl : null,
      totalItems: exportJob.totalItems ?? null,
      durationMs: exportJob.durationMs ?? null,
    },
  );
  if (!transition.count) {
    return run.status;
  }
  const existingHistory = await findExportHistoryByScheduledTask(
    exportJob.shop,
    exportJob.scheduledExportRunId,
  );
  if (!existingHistory) {
    await createScheduledExportHistory({
      data: {
        shop: exportJob.shop,
        generatedFilename: exportJob.generatedFilename || "export.csv",
        filters: {},
        status: normalizedStatus === "SUCCESS" ? "completed" : "failed",
        duration: String(exportJob.durationMs ?? 0),
        totalItems: exportJob.totalItems ?? 0,
        exportTime: completedAt,
        exportType: "Scheduled export",
        scheduledTask: exportJob.scheduledExportRunId ?? null,
        downloadUrl: normalizedStatus === "SUCCESS" ? (exportJob.downloadUrl ?? null) : null,
        errorMessage: normalizedStatus === "FAILED"
          ? (errorMessage || exportJob.error || null)
          : null,
      },
    }).catch((err) => {
      logger.error("Failed to create ExportHistory for scheduled export", {
        exportJobId,
        error: err.message,
      });
    });
  }
  await scheduledExportRepository.updateByIdForShop({
    id: exportJob.scheduledExportId,
    shop: exportJob.shop,
    data: {
      runCount: { increment: 1 },
      lastRunAt: completedAt,
      ...(normalizedStatus === "SUCCESS"
        ? {
          lastSuccessAt: completedAt,
          lastFailureReason: null,
        }
        : {
          lastFailureAt: completedAt,
          lastFailureReason:
            errorMessage || exportJob.error || "Scheduled export run failed",
        }),
    },
  });

  return normalizedStatus;
}
