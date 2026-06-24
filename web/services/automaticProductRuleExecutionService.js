import crypto from "crypto";
import { Prisma } from "../repositories/prismaTypes.js";
import { automaticProductRuleRepository } from "../repositories/automaticProductRuleRepository.js";
import { automaticProductRuleRunRepository } from "../repositories/automaticProductRuleRunRepository.js";
import {
  createAutomaticRuleApplication,
  createEditHistory,
  findEditHistoryFirst,
  findEditHistoryUnique,
  tryAdvisoryLockSession,
  tryAdvisoryLockTx,
  unlockAdvisoryLockSession,
  updateEditHistoryMany,
  withAutomaticRuleExecutionTransaction,
} from "../repositories/automaticRuleExecutionRepository.js";
import {
  assertAutomaticProductRuleAccess,
  getSubscriptionForShop,
} from "./automaticProductRulePlanService.js";
import { computeAutomaticProductRuleNextRunAt } from "./automaticProductRuleScheduleService.js";
import {
  evaluateAutomaticRuleCandidates,
  persistAppliedStateUpdates,
  persistMatchedStateUpdates,
} from "./automaticProductRuleDedupService.js";
import { Services } from "./productService/productFilterService.js";
import { getSession } from "../utils/sessionHandler.js";
import { logWorkerError } from "../utils/errorLogUtils.js";
import { getCurrentBulkOperationStatus } from "../utils/bulkOperationHelper.js";
import logger from "../utils/loggerUtils.js";
import ProductBulkService from "./productService/productBulkEditService.js";
import { addBulkEditExecuteJob } from "../Jobs/Queues/bulkEditExecuteJob.js";
import {
  AUTOMATIC_PRODUCT_RULE_EXECUTION_QUEUE,
  enqueueAutomaticRuleExecution,
  enqueueAutomaticRuleSignal,
} from "../queues/adapters/automaticRuleQueueAdapter.js";
import {
  acquireExclusiveShopWork,
  LOCK_NS,
  releaseExclusiveShopWork,
} from "./shopWorkLeaseService.js";
import {
  buildActorContext,
  buildEntitlementSnapshot,
} from "../utils/operationContextUtils.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "./operationLifecycleStateMachine.js";
import { reserveAutomaticRuleApplications as reserveAutomaticRuleApplicationsViaService } from "./automaticRuleApplicationReservationService.js";
import { RUN_STATUS } from "./automaticProductRule/automaticProductRuleConstants.js";
import {
  computeTargetSnapshotChecksum,
  freezeExplicitTargetSnapshot,
  getActiveMirrorBatchId,
} from "./productService/productTargetingService.js";
import { getTargetingVersionBundle } from "./targeting/versioning.js";
const productFilterService = new Services();
const PENDING_RUN_RECOVERY_BATCH_SIZE = 100;
const STALE_PROCESSING_RECOVERY_MINUTES = Number.parseInt(
  process.env.AUTOMATIC_RULE_STALE_PROCESSING_MINUTES || "30",
  10,
);

class RetryableAutomaticRuleError extends Error {
  constructor(message) {
    super(message);
    this.name = "RetryableAutomaticRuleError";
    this.retryable = true;
  }
}

function buildSignalExecutionKey(ruleId, triggerSource, triggerReference, productIds = []) {
  const payload = JSON.stringify({
    triggerSource,
    triggerReference: triggerReference || null,
    productIds: [...new Set(productIds.filter(Boolean))].sort(),
  });
  const hash = crypto.createHash("sha256").update(payload).digest("hex");
  return `${ruleId}:signal:${hash}`;
}

function buildScheduledExecutionKey(ruleId, scheduledFor) {
  return `${ruleId}:schedule:${new Date(scheduledFor).toISOString()}`;
}

function buildManualExecutionKey(ruleId, requestKey = null) {
  if (requestKey && String(requestKey).trim()) {
    return `${ruleId}:manual:${String(requestKey).trim()}`;
  }
  const minuteWindow = new Date().toISOString().slice(0, 16);
  return `${ruleId}:manual:${minuteWindow}`;
}

function getExecutionTargetsForAutomaticRule({ rule, candidateProducts, candidateTargets }) {
  if (rule.scopeType === "VARIANT") {
    if (!Array.isArray(candidateTargets) || candidateTargets.length === 0) {
      return [];
    }

    return candidateTargets.filter((target) => target.targetType === "VARIANT");
  }

  return Array.isArray(candidateTargets) && candidateTargets.length
    ? candidateTargets.filter((target) => target.targetType === "PRODUCT")
    : (Array.isArray(candidateProducts) ? candidateProducts : []).map((product) => ({
        targetType: "PRODUCT",
        targetIdentity: `PRODUCT:${product.id}`,
        productId: product.id,
        variantId: null,
        product,
        variant: null,
      }));
}

function assertAutomaticRuleExecutionTargets({ rule, targets }) {
  if (!Array.isArray(targets)) {
    throw new Error("Automatic rule execution requires targets array");
  }

  for (const target of targets) {
    if (!target?.targetType || !target?.targetIdentity || !target?.productId) {
      throw new Error(`Invalid automatic rule target: ${JSON.stringify(target)}`);
    }

    if (rule.scopeType === "VARIANT") {
      if (target.targetType !== "VARIANT" || !target.variantId) {
        throw new Error(
          `VARIANT scoped rule received non-variant target: ${target.targetIdentity}`,
        );
      }
    }

    if (rule.scopeType === "PRODUCT") {
      if (target.targetType !== "PRODUCT" || target.variantId) {
        throw new Error(
          `PRODUCT scoped rule received non-product target: ${target.targetIdentity}`,
        );
      }
    }
  }
}

function assertFrozenTargetsMatchRuleScope({ rule, targets }) {
  const expectedTargetType = rule.scopeType === "VARIANT" ? "VARIANT" : "PRODUCT";

  for (const target of targets) {
    if (target.targetType !== expectedTargetType) {
      throw new Error(
        `Automatic rule ${rule.id} expected ${expectedTargetType} target but received ${target.targetType}`,
      );
    }

    if (expectedTargetType === "VARIANT" && !target.variantId) {
      throw new Error(`Variant rule target missing variantId: ${target.targetIdentity}`);
    }

    if (expectedTargetType === "PRODUCT" && target.variantId) {
      throw new Error(`Product rule target unexpectedly has variantId: ${target.targetIdentity}`);
    }
  }
}

function buildTriggerReference({ triggerReference, productIds = [], source }) {
  return JSON.stringify({
    source: source || null,
    reference: triggerReference || null,
    productIds: [...new Set(productIds.filter(Boolean))].sort(),
  });
}

function buildRunRuleSnapshot(rule) {
  return {
    ruleId: rule.id,
    title: rule.title ?? null,
    scopeType: rule.scopeType,
    conditions: Array.isArray(rule.conditions) ? rule.conditions : [],
    actions: Array.isArray(rule.actions) ? rule.actions : [],
    applyMode: rule.applyMode ?? null,
    filterVersion: rule.filterVersion ?? null,
    canonicalFilterKey: rule.canonicalFilterKey ?? null,
    cooldownMinutes: rule.cooldownMinutes ?? null,
    maxAffectedPerRun: rule.maxAffectedPerRun ?? null,
  };
}

function resolveExecutionRuleFromRun({ rule, run }) {
  const snapshot = run?.ruleSnapshot && typeof run.ruleSnapshot === "object" ? run.ruleSnapshot : null;
  const conditions = Array.isArray(run?.conditionsSnapshot)
    ? run.conditionsSnapshot
    : Array.isArray(snapshot?.conditions)
      ? snapshot.conditions
      : Array.isArray(rule?.conditions)
        ? rule.conditions
        : [];
  const actions = Array.isArray(run?.actionsSnapshot)
    ? run.actionsSnapshot
    : Array.isArray(snapshot?.actions)
      ? snapshot.actions
      : Array.isArray(rule?.actions)
        ? rule.actions
        : [];

  return {
    ...rule,
    conditions,
    actions,
    scopeType: run?.scopeTypeSnapshot || snapshot?.scopeType || rule?.scopeType,
    applyMode: run?.applyModeSnapshot || snapshot?.applyMode || rule?.applyMode,
    cooldownMinutes: snapshot?.cooldownMinutes ?? rule?.cooldownMinutes,
    maxAffectedPerRun: snapshot?.maxAffectedPerRun ?? rule?.maxAffectedPerRun,
  };
}

export async function reserveAutomaticRuleApplications({
  rule,
  run,
  candidateTargets,
  candidateProducts,
  appliedStateUpdates,
}) {
  return reserveAutomaticRuleApplicationsViaService({
    createApplication: (data) => createAutomaticRuleApplication(data),
    rule,
    run,
    candidateTargets,
    candidateProducts,
    appliedStateUpdates,
  });
}

function isTerminalRunStatus(status) {
  return [RUN_STATUS.SUCCEEDED, RUN_STATUS.FAILED, RUN_STATUS.CANCELLED].includes(status);
}

function isRunWindowEligible(rule, now = new Date()) {
  if (rule.startAt && new Date(rule.startAt) > now) return false;
  if (rule.endAt && new Date(rule.endAt) < now) return false;
  return true;
}

async function enqueueExecutionRun(runId, shop, opts = {}) {
  return enqueueAutomaticRuleExecution(runId, shop, opts);
}

async function resolveExistingHistoryForRun(runId) {
  return findEditHistoryFirst({
    where: {
      automaticProductRuleRunId: runId,
    },
      select: {
        id: true,
        statusNormalized: true,
        completedAt: true,
        executionIdentity: true,
      },
    });
  }

async function reserveScheduledRun(ruleId, now) {
  return withAutomaticRuleExecutionTransaction(async (tx) => {
    const locked = await tryAdvisoryLockTx(tx, `automatic-product-rule:${ruleId}`);
    if (!locked) return null;

    const rule = await automaticProductRuleRepository.findByIdUnsafeInternal(ruleId, tx);
    if (
      !rule ||
      rule.isDeleted ||
      rule.status !== "ACTIVE" ||
      !rule.nextRunAt ||
      rule.nextRunAt > now
    ) {
      return null;
    }

    const scheduledFor = rule.nextRunAt;
    const schedulerClaimId = crypto.randomUUID();
    const claimResult = await tx.automaticProductRule.updateMany({
      where: {
        id: rule.id,
        shop: rule.shop,
        status: "ACTIVE",
        isDeleted: false,
        ...(Object.prototype.hasOwnProperty.call(rule, "schedulerDisabledAt")
          ? { schedulerDisabledAt: null }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(rule, "revision")
          ? { revision: rule.revision }
          : {}),
        nextRunAt: { lte: now },
      },
      data: {
        ...(Object.prototype.hasOwnProperty.call(rule, "schedulerClaimedAt")
          ? { schedulerClaimedAt: now }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(rule, "schedulerClaimId")
          ? { schedulerClaimId }
          : {}),
        updatedAt: now,
      },
    });
    if (claimResult.count !== 1) {
      return null;
    }

    const executionKey = buildScheduledExecutionKey(rule.id, scheduledFor);
    const existingRun = await automaticProductRuleRunRepository.findByExecutionKeyForShop(executionKey, rule.shop, tx);

    if (existingRun) {
      return {
        runId: existingRun.id,
        executionKey,
        shop: rule.shop,
        reused: true,
      };
    }

    const nextRunAt = computeAutomaticProductRuleNextRunAt(
      rule,
      new Date(scheduledFor.getTime() + 1000),
    );
    const mirrorBatchId = await getActiveMirrorBatchId(rule.shop, {
      purpose: "EXECUTE",
    });

    const run = await automaticProductRuleRunRepository.createPendingRun({
      automaticProductRuleId: rule.id,
      shop: rule.shop,
      mirrorBatchId,
      triggerSource: "SCHEDULE",
      triggerReference: buildTriggerReference({
        triggerReference: scheduledFor.toISOString(),
        source: "SCHEDULE",
      }),
      scheduledFor,
      status: RUN_STATUS.TARGET_FREEZE_QUEUED,
      executionKey,
      ruleSnapshot: buildRunRuleSnapshot(rule),
      conditionsSnapshot: Array.isArray(rule.conditions) ? rule.conditions : [],
      actionsSnapshot: Array.isArray(rule.actions) ? rule.actions : [],
      scopeTypeSnapshot: rule.scopeType,
      applyModeSnapshot: rule.applyMode ?? null,
    }, tx);

    await automaticProductRuleRepository.updateByIdForShop(rule.id, rule.shop, { nextRunAt }, tx);

    return {
      runId: run.id,
      executionKey,
      shop: rule.shop,
      reused: false,
    };
  }, {
    maxWait: 10_000,
    timeout: 20_000,
  });
}

async function markRunSkipped(run, reason, data = {}) {
  const transition = await automaticProductRuleRunRepository.markPendingSkippedForShop(run.id, run.shop, {
    errorMessage: reason,
    ...data,
  });

  if (!transition.count) {
    return null;
  }

  await automaticProductRuleRepository.updateByIdForShop(run.automaticProductRuleId, run.shop, {
    runCount: { increment: 1 },
    lastRunAt: new Date(),
  });

  return reason;
}

async function markRunFailed({ run, rule, errorMessage, processingToken = null, data = {} }) {
  if (!processingToken) {
    logger.warn("Automatic rule run failure transition skipped due to missing processing token", {
      runId: run?.id || null,
      automaticProductRuleId: rule?.id || null,
      shop: run?.shop || rule?.shop || null,
    });
    return null;
  }

  const transition = await automaticProductRuleRunRepository.markProcessingFinishedWithTokenForShop(
    {
      id: run.id,
      shop: run.shop,
      status: "FAILED",
      processingToken,
      data: {
        errorMessage,
        ...data,
      },
    },
  );

  if (!transition.count) {
    return null;
  }

  await automaticProductRuleRepository.updateByIdForShop(rule.id, rule.shop, {
    runCount: { increment: 1 },
    lastRunAt: new Date(),
    lastFailureAt: new Date(),
    lastFailureReason: errorMessage,
  });

  return errorMessage;
}

async function ensureRunProcessingToken(run, shop) {
  if (run?.processingToken) return run.processingToken;
  const token = crypto.randomUUID();
  const claimed = await automaticProductRuleRunRepository.claimPendingRunForShop(
    run.id,
    shop,
    {
      processingToken: token,
      processingOwner: "automaticProductRuleExecutionService",
    },
  );
  if (claimed.count) return token;

  const latestRun = await automaticProductRuleRunRepository.findByIdForShop(run.id, shop);
  return latestRun?.processingToken || null;
}

async function recoverPendingRuns(limit = PENDING_RUN_RECOVERY_BATCH_SIZE) {
  const pendingRuns = await automaticProductRuleRunRepository.listPendingRunsWithoutHistory(limit);
  const staleThreshold = new Date(
    Date.now() - (Number.isFinite(STALE_PROCESSING_RECOVERY_MINUTES) ? STALE_PROCESSING_RECOVERY_MINUTES : 30) * 60_000,
  );
  const staleProcessingRuns = await automaticProductRuleRunRepository.listStaleProcessingRunsWithoutHistory(
    staleThreshold,
    limit,
  );
  let enqueuedPending = 0;
  let failedStaleProcessing = 0;

  for (const run of pendingRuns) {
    try {
      await enqueueExecutionRun(run.id, run.shop);
      enqueuedPending += 1;
    } catch (error) {
      await logWorkerError({
        shop: run.shop,
        err: error,
        source: "AutomaticProductRuleExecutionService.recoverPendingRuns",
      });
    }
  }

  for (const run of staleProcessingRuns) {
    try {
      const transition = await automaticProductRuleRunRepository.markStaleProcessingFailedForShop(
        run.id,
        run.shop,
        {
          errorMessage: `Recovered stale processing run without history (startedAt=${run.startedAt ? new Date(run.startedAt).toISOString() : "unknown"})`,
        },
      );
      if (transition.count) {
        failedStaleProcessing += 1;
      }
    } catch (error) {
      await logWorkerError({
        shop: run.shop,
        err: error,
        source: "AutomaticProductRuleExecutionService.recoverStaleProcessingRuns",
      });
    }
  }

  return {
    enqueuedPending,
    failedStaleProcessing,
  };
}

export async function enqueueAutomaticProductRuleExecutionJob({ runId, shop }) {
  return enqueueExecutionRun(runId, shop);
}

export async function enqueueAutomaticProductRuleSignalJob({
  shop,
  productIds = [],
  triggerReference,
  triggerSource = "WEBHOOK",
}) {
  return enqueueAutomaticRuleSignal({
    shop,
    productIds,
    triggerReference,
    triggerSource,
  });
}

export async function reserveAutomaticProductRuleRunFromSignal({
  shop,
  productIds = [],
  triggerReference,
  triggerSource = "WEBHOOK",
}) {
  const now = new Date();
  const rules = await automaticProductRuleRepository.listRunnableEventRulesByShop(shop, now);
  let createdRuns = 0;
  let reusedRuns = 0;

  for (const rule of rules) {
    const executionKey = buildSignalExecutionKey(rule.id, triggerSource, triggerReference, productIds);

    try {
      const existingRun = await automaticProductRuleRunRepository.findByExecutionKeyForShop(executionKey, shop);
      if (existingRun) {
        if (existingRun.status === RUN_STATUS.TARGET_FREEZE_QUEUED) {
          await enqueueExecutionRun(existingRun.id, shop);
        }
        reusedRuns += 1;
        continue;
      }
      const mirrorBatchId = await getActiveMirrorBatchId(shop, {
        purpose: "EXECUTE",
      });

      const run = await automaticProductRuleRunRepository.createPendingRun({
        automaticProductRuleId: rule.id,
        shop,
        mirrorBatchId,
        triggerSource,
        triggerReference: buildTriggerReference({
          triggerReference,
          productIds,
          source: triggerSource,
        }),
        status: RUN_STATUS.TARGET_FREEZE_QUEUED,
        executionKey,
        ruleSnapshot: buildRunRuleSnapshot(rule),
        conditionsSnapshot: Array.isArray(rule.conditions) ? rule.conditions : [],
        actionsSnapshot: Array.isArray(rule.actions) ? rule.actions : [],
        scopeTypeSnapshot: rule.scopeType,
        applyModeSnapshot: rule.applyMode ?? null,
      });

      await enqueueExecutionRun(run.id, shop);
      createdRuns += 1;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existingRun = await automaticProductRuleRunRepository.findByExecutionKeyForShop(executionKey, shop);
        if (existingRun?.status === RUN_STATUS.TARGET_FREEZE_QUEUED) {
          await enqueueExecutionRun(existingRun.id, shop).catch(() => {});
        }
        reusedRuns += 1;
        continue;
      }

      await logWorkerError({
        shop,
        err: error,
        source: "AutomaticProductRuleExecutionService.reserveAutomaticProductRuleRunFromSignal",
      });
    }
  }

  return {
    createdRuns,
    reusedRuns,
  };
}

export async function scheduleDueAutomaticProductRuleRuns({ limit = 100 } = {}) {
  const schedulerLockKey = "automatic-product-rule-scheduler";
  const hasSchedulerLock = await tryAdvisoryLockSession(schedulerLockKey);

  if (!hasSchedulerLock) {
    return {
      scheduled: 0,
      recovered: 0,
      skipped: 0,
      reason: "scheduler_locked",
    };
  }

  try {
    const now = new Date();
    const dueIds = await automaticProductRuleRepository.findDueRuleIds(now, limit);
    let scheduled = 0;
    let skipped = 0;
    const recovered = await recoverPendingRuns();

    for (const { id } of dueIds) {
      try {
        const reservation = await reserveScheduledRun(id, now);
        if (!reservation?.runId) {
          skipped += 1;
          continue;
        }

        await enqueueExecutionRun(reservation.runId, reservation.shop);
        scheduled += 1;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          skipped += 1;
          continue;
        }

        await logWorkerError({
          shop: "unknown",
          err: error,
          source: "AutomaticProductRuleExecutionService.scheduleDueAutomaticProductRuleRuns",
        });
        skipped += 1;
      }
    }

    return {
      scheduled,
      recovered,
      recoveredPendingEnqueued: recovered.enqueuedPending,
      recoveredStaleFailed: recovered.failedStaleProcessing,
      skipped,
      scanned: dueIds.length,
    };
  } finally {
    await unlockAdvisoryLockSession(schedulerLockKey);
  }
}

export async function createManualAutomaticProductRuleRun({ rule, requestKey = null }) {
  const mirrorBatchId = await getActiveMirrorBatchId(rule.shop, {
    purpose: "EXECUTE",
  });
  const run = await automaticProductRuleRunRepository.createPendingRun({
    automaticProductRuleId: rule.id,
    shop: rule.shop,
    mirrorBatchId,
    triggerSource: "MANUAL",
    triggerReference: buildTriggerReference({
      triggerReference: "manual",
      source: "MANUAL",
    }),
    status: RUN_STATUS.TARGET_FREEZE_QUEUED,
    executionKey: buildManualExecutionKey(rule.id, requestKey),
    ruleSnapshot: buildRunRuleSnapshot(rule),
    conditionsSnapshot: Array.isArray(rule.conditions) ? rule.conditions : [],
    actionsSnapshot: Array.isArray(rule.actions) ? rule.actions : [],
    scopeTypeSnapshot: rule.scopeType,
    applyModeSnapshot: rule.applyMode ?? null,
  });

  await enqueueExecutionRun(run.id, rule.shop);
  return run;
}

async function failHistoryAndRun({ rule, run, historyId, error, processingToken = null }) {
  if (historyId) {
    await updateEditHistoryMany({
      where: {
        id: historyId,
        statusNormalized: {
          in: [
            normalizeEditHistoryStatus("pending"),
            normalizeEditHistoryStatus("processing"),
          ],
        },
      },
      data: {
        status: "failed",
        statusNormalized: normalizeEditHistoryStatus("failed"),
        completedAt: new Date(),
        error: {
          message: error.message,
          details: error.stack || null,
        },
      },
    }).catch(() => {});
  }

  await markRunFailed({
    run,
    rule,
    errorMessage: error.message || "Automatic rule execution failed",
    processingToken,
  });
}

export async function executeAutomaticProductRuleRun(runId, shopFromJob = null) {
  let run = await automaticProductRuleRunRepository.findByIdWithRuleUnsafeInternal(runId);
  let executionLockKey = null;
  if (!run) {
    return { skipped: true, reason: "run_not_found" };
  }

  if (isTerminalRunStatus(run.status)) {
    return { skipped: true, reason: "run_already_completed" };
  }

  const initialRule = run.automaticProductRule;
  if (shopFromJob && initialRule?.shop && initialRule.shop !== shopFromJob) {
    throw new Error("Cross-shop automatic rule execution blocked");
  }
  if (!initialRule) {
    return { skipped: true, reason: "rule_not_found" };
  }

  const subscription = await getSubscriptionForShop(initialRule.shop);
  if (
    initialRule.isDeleted ||
    initialRule.status !== "ACTIVE" ||
    !isRunWindowEligible(initialRule)
  ) {
    await markRunSkipped(run, "Automatic rule is not active for execution");
    return { skipped: true, reason: "rule_inactive" };
  }

  try {
    await assertAutomaticProductRuleAccess(subscription);
  } catch (error) {
    await markRunSkipped(run, error.message);
    return { skipped: true, reason: "plan_ineligible" };
  }

  executionLockKey = `automatic-rule-shop:${initialRule.shop}`;
  const hasShopLock = await tryAdvisoryLockSession(executionLockKey);
  if (!hasShopLock) {
    throw new RetryableAutomaticRuleError("Automatic rule execution is already running for this shop");
  }

  let exclusiveShopLockKey = null;

  try {
    run = await automaticProductRuleRunRepository.findByIdWithRuleForShop(runId, initialRule.shop);
    if (!run || isTerminalRunStatus(run.status)) {
      return { skipped: true, reason: "run_not_actionable" };
    }

    const rule = run.automaticProductRule;
    const executionRule = resolveExecutionRuleFromRun({ rule, run });
    if (
      !rule ||
      rule.isDeleted ||
      rule.status !== "ACTIVE" ||
      !isRunWindowEligible(rule)
    ) {
      await markRunSkipped(run, "Automatic rule is not active for execution");
      return { skipped: true, reason: "rule_inactive_after_lock" };
    }

    const exclusiveLock = await acquireExclusiveShopWork({
      shop: rule.shop,
      activity: "automatic_rule_execution",
      worker: "automaticProductRuleExecutionService",
      queue: AUTOMATIC_PRODUCT_RULE_EXECUTION_QUEUE,
      jobId: run.id,
      entityType: "automaticProductRuleRun",
      entityId: run.id,
      executionId: run.id,
      namespace: LOCK_NS.WRITE_CATALOG,
    });

    if (!exclusiveLock.acquired) {
      throw new RetryableAutomaticRuleError("Another heavy job is already running for this shop");
    }

    exclusiveShopLockKey = exclusiveLock.lockKey;

    const latestSubscription = await getSubscriptionForShop(rule.shop);
    try {
      await assertAutomaticProductRuleAccess(latestSubscription);
    } catch (error) {
      await markRunSkipped(run, error.message);
      return { skipped: true, reason: "plan_ineligible_after_lock" };
    }

    const session = await getSession(rule.shop);
    const { status: bulkStatus } = await getCurrentBulkOperationStatus(session);
    if (bulkStatus === "RUNNING") {
      throw new RetryableAutomaticRuleError("A Shopify bulk operation is already running for this shop");
    }
    if (!run.mirrorBatchId) {
      throw new RetryableAutomaticRuleError(
        "Automatic rule run is missing mirrorBatchId; cannot execute deterministic targets",
      );
    }

    if (run.editHistoryId) {
      const history = await findEditHistoryUnique({
        where: { id: run.editHistoryId },
        select: { id: true, statusNormalized: true, completedAt: true, executionIdentity: true },
      });

      if (history?.statusNormalized === normalizeEditHistoryStatus("completed")) {
        await finalizeAutomaticProductRuleRunFromHistory({
          historyId: history.id,
          status: "SUCCESS",
          processingToken: run.processingToken || null,
        });
        return { skipped: true, reason: "history_already_completed" };
      }

      if (history?.statusNormalized === normalizeEditHistoryStatus("failed")) {
        await finalizeAutomaticProductRuleRunFromHistory({
          historyId: history.id,
          status: "FAILED",
          errorMessage: "Edit history already failed",
          processingToken: run.processingToken || null,
        });
        return { skipped: true, reason: "history_already_failed" };
      }

      await addBulkEditExecuteJob({
        historyId: run.editHistoryId,
        shop: rule.shop,
        source: "automatic_rule_resume",
        executionId: history.executionIdentity || history.id,
      });
      return {
        queued: true,
        runId: run.id,
        editHistoryId: run.editHistoryId,
      };
    }

    const existingHistory = await resolveExistingHistoryForRun(run.id);
    if (existingHistory) {
      const processingToken = await ensureRunProcessingToken(run, rule.shop);
      if (!processingToken) {
        return { skipped: true, reason: "run_already_claimed" };
      }
      run = {
        ...run,
        status: RUN_STATUS.EXECUTING,
        startedAt: run.startedAt || new Date(),
        processingToken,
      };
      await automaticProductRuleRunRepository.attachEditHistoryIdempotentForShop({
        id: run.id,
        shop: rule.shop,
        editHistoryId: existingHistory.id,
        processingToken,
      });

      if (existingHistory.statusNormalized === normalizeEditHistoryStatus("completed")) {
        await finalizeAutomaticProductRuleRunFromHistory({
          historyId: existingHistory.id,
          status: "SUCCESS",
          processingToken,
        });
        return { skipped: true, reason: "history_recovered_completed" };
      }

      if (existingHistory.statusNormalized === normalizeEditHistoryStatus("failed")) {
        await finalizeAutomaticProductRuleRunFromHistory({
          historyId: existingHistory.id,
          status: "FAILED",
          errorMessage: "Recovered failed edit history",
          processingToken,
        });
        return { skipped: true, reason: "history_recovered_failed" };
      }

      await addBulkEditExecuteJob({
        historyId: existingHistory.id,
        shop: rule.shop,
        source: "automatic_rule_recovery",
        executionId: existingHistory.executionIdentity || existingHistory.id,
      });
      return {
        queued: true,
        runId: run.id,
        editHistoryId: existingHistory.id,
        recovered: true,
      };
    }

    const where = productFilterService.getProductPrismaWhere(
      Array.isArray(executionRule.conditions) ? executionRule.conditions : [],
      rule.shop,
    );

    const {
      matchedCount,
      candidateProducts,
      candidateTargets,
      matchedStateUpdates,
      appliedStateUpdates,
    } = await evaluateAutomaticRuleCandidates({
      rule: executionRule,
      run,
      where,
    });

    await persistMatchedStateUpdates(rule, matchedStateUpdates, run);

    const executionTargets = getExecutionTargetsForAutomaticRule({
      rule: executionRule,
      candidateProducts,
      candidateTargets,
    });
    assertAutomaticRuleExecutionTargets({
      rule: executionRule,
      targets: executionTargets,
    });

    if (!executionTargets.length) {
      await markRunSkipped(run, "No eligible targets remained after dedupe checks", {
        matchedCount,
        affectedCount: 0,
      });

      return {
        skipped: true,
        reason: "no_candidates",
        matchedCount,
      };
    }

    const reservedApplications = await reserveAutomaticRuleApplications({
      rule: executionRule,
      run,
      candidateTargets: executionTargets,
      candidateProducts,
      appliedStateUpdates,
    });
    const gatedTargets = Array.isArray(reservedApplications.acceptedTargets)
      ? reservedApplications.acceptedTargets
      : [];
    assertAutomaticRuleExecutionTargets({
      rule: executionRule,
      targets: gatedTargets,
    });
    if (!gatedTargets.length) {
      await markRunSkipped(
        run,
        "No eligible targets remained after application dedupe gate",
        {
          matchedCount,
          affectedCount: 0,
        },
      );
      return {
        skipped: true,
        reason: "application_dedupe_gate",
        matchedCount,
      };
    }

    const gatedTargetIdentitySet = new Set(
      gatedTargets
        .map((target) => target?.targetIdentity)
        .filter(Boolean),
    );
    const gatedStateUpdates = appliedStateUpdates.filter((update) =>
      gatedTargetIdentitySet.has(update.targetIdentity),
    );

    const processingToken = crypto.randomUUID();
    const movedToProcessing = await automaticProductRuleRunRepository.claimPendingRunForShop(
      run.id,
      rule.shop,
      {
        processingToken,
        processingOwner: "automaticProductRuleExecutionService",
      },
    );
    if (!movedToProcessing.count) {
      return { skipped: true, reason: "run_already_claimed" };
    }
    run = {
      ...run,
      status: RUN_STATUS.EXECUTING,
      startedAt: run.startedAt || new Date(),
      processingToken,
    };

    const productIds = [...new Set(
      gatedTargets
        .map((target) => target?.productId)
        .filter(Boolean),
    )];
    const variantIds = [...new Set(
      gatedTargets
        .map((target) => target?.variantId)
        .filter(Boolean),
    )];
    const automaticRuleTargetType = executionRule.scopeType === "VARIANT" ? "VARIANT" : "PRODUCT";
    assertFrozenTargetsMatchRuleScope({
      rule: executionRule,
      targets: gatedTargets,
    });
    const bulkService = new ProductBulkService(session);
    let editHistoryId = null;
    let editHistoryExecutionIdentity = null;

    try {
      const baseHistory = await bulkService._bulkOperationEdit(
        {
          filterParams: executionRule.conditions,
          productIds,
          variantIds,
          targetType: automaticRuleTargetType,
          explicitTargets: gatedTargets.map((target) => ({
            targetType: target.targetType,
            targetIdentity: target.targetIdentity,
            productId: target.productId,
            variantId: target.variantId || null,
          })),
          queryWhere: {
            shop: rule.shop,
            id: {
              in: productIds,
            },
          },
          rules: executionRule.actions,
          title: rule.title,
        },
        {
          planKey: "PRO_MONTHLY",
          planName: "Pro Monthly",
          isUnlimited: true,
          limit: Number.MAX_SAFE_INTEGER,
          status: "ACTIVE",
        },
        {
          actor: buildActorContext({
            session,
            fallbackType: "SYSTEM",
          }),
          entitlementSnapshot: buildEntitlementSnapshot({
            planKey: "PRO_MONTHLY",
            planName: "Pro Monthly",
            isUnlimited: true,
            limit: Number.MAX_SAFE_INTEGER,
            status: "ACTIVE",
          }),
        },
      );

      const prepared = await withAutomaticRuleExecutionTransaction(async (tx) => {
        const editHistory = await tx.editHistory.create({
          data: {
            ...baseHistory,
            type: "Automatic rule",
            automaticProductRuleId: rule.id,
            automaticProductRuleRunId: run.id,
            triggerType: "AUTOMATIC_RULE",
            executionState: OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
            executionStateNormalized: normalizeEditHistoryExecutionState(
              OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
            ),
            batch: {
              automaticRuleTargetType,
              automaticRuleStateUpdates: gatedStateUpdates,
              automaticRuleMatchedCount: matchedCount,
              automaticRuleAffectedProductIds: productIds,
              automaticRuleAffectedVariantIds: variantIds,
              automaticRuleAffectedTargets: gatedTargets.map((target) => ({
                targetType: target.targetType,
                targetIdentity: target.targetIdentity,
                productId: target.productId,
                variantId: target.variantId || null,
              })),
            },
          },
        });

        const frozenCount = await freezeExplicitTargetSnapshot({
          shop: rule.shop,
          ownerType: "EDIT_HISTORY",
          ownerId: editHistory.id,
          source: "AUTOMATIC_RULE_RUN",
          mirrorBatchId: run.mirrorBatchId,
          filterHash: crypto.createHash("sha256")
            .update(JSON.stringify(gatedTargets.map((target) => ({
              targetType: target.targetType,
              productId: target.productId,
              variantId: target.variantId || null,
            }))))
            .digest("hex"),
          targetGranularity: automaticRuleTargetType,
          targets: gatedTargets.map((target) => ({
            targetType: target.targetType,
            targetIdentity: target.targetIdentity,
            productId: target.productId,
            variantId: target.variantId || null,
            beforeValues: {
              productId: target.productId,
              variantId: target.variantId || null,
              fingerprint: target.fingerprint || null,
            },
          })),
          db: tx,
        });
        if (frozenCount !== gatedTargets.length) {
          throw new Error(
            `Automatic rule target freeze mismatch: gated=${gatedTargets.length}, frozen=${frozenCount}`,
          );
        }
        const frozenTransition = await tx.editHistory.updateMany({
          where: {
            id: editHistory.id,
            shop: rule.shop,
            executionState: OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
          },
          data: {
            totalItems: frozenCount,
            targetSnapshotCount: frozenCount,
            targetMirrorBatchId: run.mirrorBatchId,
            executionState: OPERATION_LIFECYCLE_STATES.TARGET_FROZEN,
            executionStateNormalized: normalizeEditHistoryExecutionState(
              OPERATION_LIFECYCLE_STATES.TARGET_FROZEN,
            ),
          },
        });
        if (frozenTransition.count !== 1) {
          throw new Error("AUTOMATIC_RULE_STATE_TRANSITION_REJECTED_TARGET_FROZEN");
        }
        const snapshotChecksum = await computeTargetSnapshotChecksum({
          ownerType: "EDIT_HISTORY",
          ownerId: editHistory.id,
          shop: rule.shop,
          mirrorBatchId: run.mirrorBatchId,
          db: tx,
        });
        const versions = getTargetingVersionBundle();
        await tx.editHistory.updateMany({
          where: {
            id: editHistory.id,
            shop: rule.shop,
            executionState: OPERATION_LIFECYCLE_STATES.TARGET_FROZEN,
          },
          data: {
            targetingSnapshotMeta: {
              shop: rule.shop,
              source: "AUTOMATIC_RULE_RUN",
              mirrorBatchId: run.mirrorBatchId,
              targetCount: frozenCount,
              filterHash: crypto.createHash("sha256")
                .update(JSON.stringify(gatedTargets.map((target) => ({
                  targetType: target.targetType,
                  productId: target.productId,
                  variantId: target.variantId || null,
                }))))
                .digest("hex"),
              snapshotChecksum,
              targetGranularity: automaticRuleTargetType,
              astVersion: versions.filterAstVersion,
              compilerVersion: versions.targetingCompilerVersion,
              fieldRegistryVersion: versions.fieldRegistryVersion,
              operatorRegistryVersion: versions.operatorRegistryVersion,
              resolvedAt: new Date(),
            },
          },
        });
        return {
          editHistoryId: editHistory.id,
          executionIdentity: editHistory.executionIdentity,
          frozenCount,
          snapshotChecksum,
        };
      });
      editHistoryId = prepared.editHistoryId;
      editHistoryExecutionIdentity = prepared.executionIdentity;
      if (!editHistoryId) {
        throw new Error(
          "Automatic rule history creation failed before queue",
        );
      }
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const recoveredHistory = await resolveExistingHistoryForRun(run.id);
        if (recoveredHistory) {
          editHistoryId = recoveredHistory.id;
          editHistoryExecutionIdentity = recoveredHistory.executionIdentity;
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }

    try {
      await automaticProductRuleRunRepository.updateProcessingCountsForShop(run.id, rule.shop, {
        editHistoryId,
        matchedCount,
        affectedCount: gatedTargets.length,
        processingToken: run.processingToken || null,
        mirrorBatchId: run.mirrorBatchId,
        filterHash: crypto.createHash("sha256")
          .update(JSON.stringify(gatedTargets.map((target) => ({
            targetType: target.targetType,
            productId: target.productId,
            variantId: target.variantId || null,
          }))))
          .digest("hex"),
        targetGranularity: automaticRuleTargetType,
        targetingSnapshotMeta: {
          shop: rule.shop,
          source: "AUTOMATIC_RULE_RUN",
          mirrorBatchId: run.mirrorBatchId,
          targetCount: prepared.frozenCount,
          filterHash: crypto.createHash("sha256")
            .update(JSON.stringify(gatedTargets.map((target) => ({
              targetType: target.targetType,
              productId: target.productId,
              variantId: target.variantId || null,
            }))))
            .digest("hex"),
          snapshotChecksum: prepared.snapshotChecksum || null,
          targetGranularity: automaticRuleTargetType,
          resolvedAt: new Date(),
        },
      });

      await addBulkEditExecuteJob({
        historyId: editHistoryId,
        shop: rule.shop,
        source: "automatic_rule",
        executionId: editHistoryExecutionIdentity || editHistoryId,
      });
      const queued = await updateEditHistoryMany({
        where: {
          id: editHistoryId,
          shop: rule.shop,
          executionState: OPERATION_LIFECYCLE_STATES.TARGET_FROZEN,
        },
        data: {
          executionState: OPERATION_LIFECYCLE_STATES.QUEUED,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            OPERATION_LIFECYCLE_STATES.QUEUED,
          ),
        },
      });
      if (queued.count !== 1) {
        throw new Error("AUTOMATIC_RULE_STATE_TRANSITION_REJECTED_QUEUED");
      }
      const queueTransition = await automaticProductRuleRunRepository.markQueuedForShop(
        run.id,
        rule.shop,
        run.processingToken || null,
      );
      if (!queueTransition.count) {
        throw new Error("Automatic rule run queue mark rejected due to processing token mismatch");
      }
    } catch (error) {
      await failHistoryAndRun({
        rule,
        run,
        historyId: editHistoryId,
        error,
        processingToken: run.processingToken || null,
      });
      throw error;
    }

    logger.info("Automatic rule execution queued", {
      shop: rule.shop,
      automaticProductRuleId: rule.id,
      runId: run.id,
      editHistoryId,
      matchedCount,
      affectedCount: gatedTargets.length,
      triggerSource: run.triggerSource,
    });

    return {
      success: true,
      runId: run.id,
      editHistoryId,
      matchedCount,
      affectedCount: gatedTargets.length,
    };
  } catch (error) {
    if (error instanceof RetryableAutomaticRuleError) {
      logger.warn("Automatic rule execution deferred", {
        runId,
        reason: error.message,
      });
      throw error;
    }

    if (run?.automaticProductRule && run.status === RUN_STATUS.EXECUTING && !run.editHistoryId) {
      await markRunFailed({
        run,
        rule: run.automaticProductRule,
        errorMessage: error.message || "Automatic rule execution failed",
        processingToken: run.processingToken || null,
      }).catch(() => {});
    }

    await logWorkerError({
      shop: run?.shop || initialRule.shop,
      err: error,
      source: "AutomaticProductRuleExecutionService.executeAutomaticProductRuleRun",
    });

    throw error;
  } finally {
    await releaseExclusiveShopWork(exclusiveShopLockKey);
    if (executionLockKey) {
      await unlockAdvisoryLockSession(executionLockKey).catch(() => {});
    }
  }
}

export async function finalizeAutomaticProductRuleRunFromHistory({
  historyId,
  status,
  errorMessage = null,
  processingToken = null,
}) {
  const history = await findEditHistoryUnique({
    where: { id: historyId },
    select: {
      shop: true,
      automaticProductRuleId: true,
      automaticProductRuleRunId: true,
      batch: true,
      status: true,
      completedAt: true,
    },
  });

  if (!history?.automaticProductRuleId || !history?.automaticProductRuleRunId) {
    return null;
  }

  const run = await automaticProductRuleRunRepository.findByIdForShop(history.automaticProductRuleRunId, history.shop);
  if (!run) {
    return null;
  }

  if (isTerminalRunStatus(run.status)) {
    return run.status;
  }

  const completedAt = history.completedAt || new Date();
  const normalizedStatus =
    status === "SUCCESS" || status === RUN_STATUS.SUCCEEDED
      ? RUN_STATUS.SUCCEEDED
      : RUN_STATUS.FAILED;

  const tokenForTransition = processingToken || run.processingToken || null;
  if (!tokenForTransition) {
    logger.warn("Automatic rule run finalization skipped due to missing processing token", {
      runId: history.automaticProductRuleRunId,
      historyId,
      shop: run.shop,
      status: normalizedStatus,
    });
    return run.status;
  }

  const transition = await automaticProductRuleRunRepository.markProcessingFinishedWithTokenForShop(
    {
      id: history.automaticProductRuleRunId,
      shop: run.shop,
      status: normalizedStatus,
      processingToken: tokenForTransition,
      data: {
        completedAt,
        errorMessage: normalizedStatus === RUN_STATUS.FAILED
          ? errorMessage || "Automatic rule run failed"
          : null,
      },
    },
  );

  if (!transition.count) {
    return run.status;
  }

  await automaticProductRuleRepository.updateByIdForShop(history.automaticProductRuleId, run.shop, {
    runCount: { increment: 1 },
    lastRunAt: completedAt,
    ...(normalizedStatus === RUN_STATUS.SUCCEEDED
      ? {
          lastSuccessAt: completedAt,
          lastFailureReason: null,
        }
      : {
          lastFailureAt: completedAt,
          lastFailureReason: errorMessage || "Automatic rule run failed",
        }),
  });

  if (normalizedStatus === RUN_STATUS.SUCCEEDED) {
    const appliedStateUpdates = Array.isArray(history.batch?.automaticRuleStateUpdates)
      ? history.batch.automaticRuleStateUpdates
      : [];

    await persistAppliedStateUpdates(
      {
        id: history.automaticProductRuleId,
        shop: run.shop,
      },
      appliedStateUpdates,
      run,
    );
  }

  return normalizedStatus;
}


