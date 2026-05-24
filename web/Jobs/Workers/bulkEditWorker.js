import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { getCurrentBulkOperationStatus } from "../../utils/bulkOperationHelper.js";
import ProductBulkService from "../../services/productService/productBulkEditService.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
import { logWorkerError } from "../../utils/errorLogUtils.js";
import { finalizeRecurringRunFromHistory } from "../../services/recurringEditExecutionService.js";
import { finalizeAutomaticProductRuleRunFromHistory } from "../../services/automaticProductRuleExecutionService.js";
import { prisma } from "../../config/database.js";
import { recordMirrorAnomaly } from "../../services/mirrorAnomalyService.js";
import {
  acquireExclusiveShopWork,
  LOCK_NS,
  releaseExclusiveShopWork,
} from "../../services/shopWorkLeaseService.js";
import {
  getJobAttempt,
  isRetryExhausted,
  recordRetryExhausted,
} from "../../utils/workerTelemetry.js";
import { getSession } from "../../utils/sessionHandler.js";
import logger from "../../utils/loggerUtils.js";
import { adminGraphqlWithRetry } from "../../utils/shopifyAdminApi.js";
import {
  acquireShopifyExecutionBudget,
  releaseShopifyExecutionBudget,
} from "../../services/shopifyApiBudgetService.js";
import { recordDeadLetterJob } from "../../services/deadLetterRecoveryService.js";
import {
  BULK_EDIT_EXECUTION_STATES,
  appendExecutionError,
  buildExecutionError,
  isTerminalExecutionState,
} from "../../services/bulkEditExecutionStateService.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../../utils/normalizedStateUtils.js";
import {
  acquireOperationLease,
  buildLeaseOwnerId,
  heartbeatOperationLease,
  releaseOperationLease,
} from "../../services/operationLeaseService.js";
import { computeTargetSnapshotChecksum } from "../../services/productService/productTargetingService.js";
import { assertImmutableEditCommandIntegrity } from "../../services/bulkEdit/immutableEditCommand.js";
import { OPERATION_LIFECYCLE_STATES } from "../../services/operationLifecycleStateMachine.js";
import {
  beginEditHistoryStage,
  completeEditHistoryStage,
  failEditHistoryStage,
} from "../../services/operationStageIdempotencyService.js";

const QUEUE_NAME = process.env.EDIT_QUEUE || "bulk-edit";
const WORKER_NAME = "bulkEditWorker";
const STALE_DISPATCH_MS = 20 * 60 * 1000;
const CONFLICT_POLICIES = Object.freeze({
  SKIP_CHANGED_TARGETS: "SKIP_CHANGED_TARGETS",
  OVERWRITE_ANYWAY: "OVERWRITE_ANYWAY",
  FAIL_OPERATION: "FAIL_OPERATION",
});
const RISKY_CONFLICT_FIELDS = new Set([
  "price",
  "compareAtPrice",
  "inventory",
  "status",
  "title",
  "deleteProducts",
  "metafield",
  "metafields",
]);

function assertNoRawTargetingPayload(jobData = {}) {
  if (
    Object.prototype.hasOwnProperty.call(jobData, "filterParams") ||
    Object.prototype.hasOwnProperty.call(jobData, "filterAst") ||
    Object.prototype.hasOwnProperty.call(jobData, "queryFilter")
  ) {
    const error = new Error("RAW_TARGETING_PAYLOAD_FORBIDDEN");
    error.code = "RAW_TARGETING_PAYLOAD_FORBIDDEN";
    throw error;
  }
}

async function assertFrozenSnapshotReady(history) {
  const expectedCount = Number(history?.targetSnapshotCount || 0);
  const where = {
    shop: history.shop,
    ownerType: "EDIT_HISTORY",
    ownerId: history.id,
    ...(history?.targetMirrorBatchId ? { mirrorBatchId: history.targetMirrorBatchId } : {}),
  };
  const actualCount = await prisma.targetSnapshot.count({ where });

  // Execution must consume frozen TargetSnapshot rows only.
  // If preview resolved to zero, frozen set may legitimately be empty.
  if (expectedCount === 0 && actualCount === 0) {
    return;
  }

  if (actualCount <= 0) {
    const error = new Error("FROZEN_TARGET_SNAPSHOT_REQUIRED");
    error.code = "FROZEN_TARGET_SNAPSHOT_REQUIRED";
    throw error;
  }
}

function assertImmutableExecutionIntent(history) {
  const command = history?.batch?.immutableEditCommand || null;
  assertImmutableEditCommandIntegrity(command);
}

class RetryableBulkEditError extends Error {
  constructor(message, code = "retryable_bulk_edit", details = null) {
    super(message);
    this.name = "RetryableBulkEditError";
    this.retryable = true;
    this.code = code;
    this.details = details;
  }
}

function isRetryableError(error) {
  return Boolean(error?.retryable);
}

function isStaleDispatch(batch) {
  const startedAt = batch?.dispatchStartedAt;
  if (!startedAt) return false;

  const startedTs = new Date(startedAt).getTime();
  if (Number.isNaN(startedTs)) return false;

  return Date.now() - startedTs > STALE_DISPATCH_MS;
}

function deriveVariantIdentity(variantFieldChanges) {
  if (!Array.isArray(variantFieldChanges) || variantFieldChanges.length === 0) {
    return null;
  }
  const variantIds = variantFieldChanges
    .map((item) => item?.variantId)
    .filter(Boolean);
  if (!variantIds.length) return null;
  const unique = [...new Set(variantIds)].sort();
  return unique.join(",");
}

async function fetchNodesForConflictCheck(session, ids = []) {
  const uniqueIds = [...new Set(ids.filter(Boolean).map((id) => String(id)))];
  if (!uniqueIds.length) return new Map();
  const chunks = [];
  for (let i = 0; i < uniqueIds.length; i += 100) {
    chunks.push(uniqueIds.slice(i, i + 100));
  }
  const map = new Map();
  for (const chunk of chunks) {
    const response = await adminGraphqlWithRetry({
      session,
      operationName: "bulk-edit-conflict-check",
      data: {
        query: `#graphql
          query BulkEditConflictNodes($ids: [ID!]!) {
            nodes(ids: $ids) {
              __typename
              id
              ... on Product {
                title
                status
                vendor
                productType
                handle
              }
              ... on ProductVariant {
                price
                compareAtPrice
                sku
                barcode
                inventoryQuantity
              }
            }
          }
        `,
        variables: { ids: chunk },
      },
    });
    const nodes = response?.body?.data?.nodes || [];
    for (const node of nodes) {
      if (node?.id) map.set(String(node.id), node);
    }
  }
  return map;
}

function mapFieldForConflictCheck(field) {
  if (field === "inventory") return "inventoryQuantity";
  return field;
}

async function applyPreMutationConflictPolicy({
  session,
  rules = [],
  changes = [],
  formattedProducts = "",
  conflictPolicy = null,
}) {
  const risky = Array.isArray(rules)
    && rules.some((rule) => RISKY_CONFLICT_FIELDS.has(String(rule?.field || "")));
  const effectivePolicy = String(
    conflictPolicy || (risky ? CONFLICT_POLICIES.SKIP_CHANGED_TARGETS : CONFLICT_POLICIES.OVERWRITE_ANYWAY),
  ).toUpperCase();
  if (effectivePolicy === CONFLICT_POLICIES.OVERWRITE_ANYWAY) {
    return {
      effectivePolicy,
      safeChanges: changes,
      safeFormattedProducts: formattedProducts,
      conflicts: [],
    };
  }

  const ids = [
    ...changes.map((change) => change?.productId).filter(Boolean),
    ...changes.flatMap((change) => Array.isArray(change?.variantFieldChanges)
      ? change.variantFieldChanges.map((item) => item?.variantId).filter(Boolean)
      : []),
  ];
  const nodeMap = await fetchNodesForConflictCheck(session, ids);
  const conflicts = [];
  const conflictIndexes = new Set();

  changes.forEach((change, index) => {
    const productNode = nodeMap.get(String(change?.productId || ""));
    const productChanges = Array.isArray(change?.productFieldChanges) ? change.productFieldChanges : [];
    for (const item of productChanges) {
      const field = String(item?.field || "");
      const expectedBefore = item?.oldValue;
      const current = productNode ? productNode[mapFieldForConflictCheck(field)] : null;
      if (expectedBefore !== undefined && expectedBefore !== null && String(current) !== String(expectedBefore)) {
        conflictIndexes.add(index);
        conflicts.push({
          targetIdentity: `PRODUCT:${change?.productId}`,
          field,
          expectedBefore,
          current,
        });
      }
    }
    const variantChanges = Array.isArray(change?.variantFieldChanges) ? change.variantFieldChanges : [];
    for (const item of variantChanges) {
      const field = String(item?.field || "");
      const expectedBefore = item?.oldValue;
      const variantNode = nodeMap.get(String(item?.variantId || ""));
      const current = variantNode ? variantNode[mapFieldForConflictCheck(field)] : null;
      if (expectedBefore !== undefined && expectedBefore !== null && String(current) !== String(expectedBefore)) {
        conflictIndexes.add(index);
        conflicts.push({
          targetIdentity: `VARIANT:${item?.variantId}`,
          field,
          expectedBefore,
          current,
        });
      }
    }
  });

  if (conflicts.length && effectivePolicy === CONFLICT_POLICIES.FAIL_OPERATION) {
    const err = new Error("CONFLICT_DETECTED");
    err.code = "CONFLICT_DETECTED";
    err.details = { conflicts: conflicts.slice(0, 200) };
    throw err;
  }

  const lines = String(formattedProducts || "")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const safeChanges = [];
  const safeLines = [];
  changes.forEach((change, index) => {
    if (!conflictIndexes.has(index)) {
      safeChanges.push(change);
      if (lines[index]) safeLines.push(lines[index]);
    }
  });

  return {
    effectivePolicy,
    safeChanges,
    safeFormattedProducts: safeLines.join("\n"),
    conflicts: conflicts.slice(0, 200),
  };
}

async function findAutomaticRuleProcessingToken(historyId) {
  if (!historyId) return null;
  const history = await prisma.editHistory.findUnique({
    where: { id: historyId },
    select: { automaticProductRuleRunId: true },
  });
  if (!history?.automaticProductRuleRunId) return null;
  const run = await prisma.automaticProductRuleRun.findUnique({
    where: { id: history.automaticProductRuleRunId },
    select: { processingToken: true },
  });
  return run?.processingToken || null;
}

function toChangeRecordV2(change, mirrorBatchId) {
  const variantIdentity = deriveVariantIdentity(change?.variantFieldChanges);
  const productId = change?.productId;
  const isVariantScoped = Boolean(variantIdentity);

  return {
    ...change,
    targetType: isVariantScoped ? "VARIANT" : "PRODUCT",
    targetIdentity: isVariantScoped
      ? `PRODUCT:${productId}:VARIANTS:${variantIdentity}`
      : `PRODUCT:${productId}`,
    variantId: variantIdentity,
    mirrorBatchId: mirrorBatchId || null,
    beforeValues: {
      productFieldChanges: Array.isArray(change?.productFieldChanges)
        ? change.productFieldChanges
        : [],
      variantFieldChanges: Array.isArray(change?.variantFieldChanges)
        ? change.variantFieldChanges
        : [],
    },
    afterValues: {
      productFieldChanges: Array.isArray(change?.productFieldChanges)
        ? change.productFieldChanges.map((item) => ({
          field: item?.field,
          newValue: item?.newValue ?? null,
        }))
        : [],
      variantFieldChanges: Array.isArray(change?.variantFieldChanges)
        ? change.variantFieldChanges.map((item) => ({
          field: item?.field,
          newValue: item?.newValue ?? null,
          variantId: item?.variantId || null,
        }))
        : [],
    },
    options: {
      fieldPath: Array.isArray(change?.productFieldChanges) && change.productFieldChanges[0]?.field
        ? `product.${change.productFieldChanges[0].field}`
        : Array.isArray(change?.variantFieldChanges) && change.variantFieldChanges[0]?.field
          ? `variant.${change.variantFieldChanges[0].field}`
          : null,
      mutationType: "PRODUCT_SET",
      capturedAt: new Date().toISOString(),
      sourceMirrorBatchId: mirrorBatchId || null,
    },
    status: "PENDING",
  };
}

function assertUndoContractForDestructiveExecution(rules = [], changes = []) {
  const isDestructive = Array.isArray(rules)
    && rules.some((rule) => String(rule?.field || "") === "deleteProducts");
  if (!isDestructive) return;
  const hasMissingBefore = changes.some((change) => {
    const productBefore = Array.isArray(change?.productFieldChanges)
      ? change.productFieldChanges
      : [];
    const variantBefore = Array.isArray(change?.variantFieldChanges)
      ? change.variantFieldChanges
      : [];
    return productBefore.length === 0 && variantBefore.length === 0;
  });
  if (hasMissingBefore) {
    const error = new Error("UNDO_BEFORE_VALUES_REQUIRED");
    error.code = "UNDO_BEFORE_VALUES_REQUIRED";
    throw error;
  }
}

async function claimHistoryExecution(historyId, shop, executionId, jobId, attempt) {
  const history = await prisma.editHistory.findUnique({
    where: { id: historyId },
    select: {
      id: true,
      shop: true,
      statusNormalized: true,
      executionState: true,
      executionStateNormalized: true,
      rules: true,
      batch: true,
      targetSnapshotCount: true,
      targetMirrorBatchId: true,
      targetingSnapshotMeta: true,
      executionIdentity: true,
      bulkOperationId: true,
      error: true,
      completedAt: true,
    },
  });

  if (!history) {
    throw new Error("Edit history not found");
  }

  if (history.shop !== shop) {
    throw new Error("Cross-shop bulk edit execution blocked");
  }

  if (executionId && history.executionIdentity && executionId !== history.executionIdentity) {
    throw new Error("Bulk edit execution identity mismatch");
  }

  const executionState = String(history.executionStateNormalized || "").toLowerCase();
  if (
    isTerminalExecutionState(executionState) ||
    ["COMPLETED", "FAILED", "UNKNOWN", "PARTIAL"].includes(history.statusNormalized || "")
  ) {
    return { state: "terminal", history };
  }

  if (String(history.executionState || "").toUpperCase() === "PAUSED") {
    return { state: "paused", history };
  }

  if (
    history.executionStateNormalized === normalizeEditHistoryExecutionState(
      BULK_EDIT_EXECUTION_STATES.AWAITING_SHOPIFY,
    ) &&
    history.bulkOperationId
  ) {
    return { state: "awaiting_shopify", history };
  }

  await assertFrozenSnapshotReady(history);
  assertImmutableExecutionIntent(history);

  if (
    history.executionStateNormalized === normalizeEditHistoryExecutionState(
      BULK_EDIT_EXECUTION_STATES.FINALIZING,
    )
  ) {
    return { state: "finalizing", history };
  }

  const batch = history.batch && typeof history.batch === "object" ? history.batch : {};
  if (
    history.executionStateNormalized === normalizeEditHistoryExecutionState(
      BULK_EDIT_EXECUTION_STATES.DISPATCHING,
    )
  ) {
    if (!history.bulkOperationId && isStaleDispatch(batch)) {
      const structuredError = buildExecutionError({
        code: "dispatch_stalled",
        stage: "dispatch",
        message: "Bulk edit dispatch stalled before Shopify mutation confirmation",
        retryable: false,
        details: {
          dispatchStartedAt: batch.dispatchStartedAt,
          dispatchJobId: batch.dispatchJobId || null,
          dispatchAttempt: batch.dispatchAttempt || null,
        },
      });

      await prisma.editHistory.updateMany({
        where: {
          id: historyId,
          shop,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            BULK_EDIT_EXECUTION_STATES.DISPATCHING,
          ),
          bulkOperationId: null,
        },
        data: {
          status: "failed",
          statusNormalized: normalizeEditHistoryStatus("failed"),
          executionState: BULK_EDIT_EXECUTION_STATES.FAILED,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            BULK_EDIT_EXECUTION_STATES.FAILED,
          ),
          failureStage: "dispatch_timeout",
          error: appendExecutionError(history.error, structuredError),
          completedAt: new Date(),
        },
      });

      return { state: "stale_dispatch_failed", history };
    }

    return { state: "already_running", history };
  }

  const nextBatch = {
    ...batch,
    dispatchStartedAt: new Date().toISOString(),
    dispatchJobId: jobId,
    dispatchAttempt: attempt,
    activeExecutionId: history.executionIdentity,
  };

  const updated = await prisma.editHistory.updateMany({
    where: {
      id: historyId,
      shop,
      bulkOperationId: null,
      executionStateNormalized: {
        in: [
          normalizeEditHistoryExecutionState(BULK_EDIT_EXECUTION_STATES.PLANNED),
          normalizeEditHistoryExecutionState(BULK_EDIT_EXECUTION_STATES.QUEUED),
          normalizeEditHistoryExecutionState(BULK_EDIT_EXECUTION_STATES.FAILED),
        ],
      },
      statusNormalized: {
        notIn: [
          normalizeEditHistoryStatus("completed"),
          normalizeEditHistoryStatus("failed"),
          normalizeEditHistoryStatus("partial"),
        ],
      },
    },
    data: {
      status: "processing",
      statusNormalized: normalizeEditHistoryStatus("processing"),
      executionState: OPERATION_LIFECYCLE_STATES.EXECUTING,
      executionStateNormalized: normalizeEditHistoryExecutionState(
        OPERATION_LIFECYCLE_STATES.EXECUTING,
      ),
      error: null,
      failureStage: null,
      batch: nextBatch,
    },
  });

  if (!updated.count) {
    return { state: "not_claimed", history };
  }

  const claimedHistory = await prisma.editHistory.findUnique({
    where: { id: historyId },
    select: {
      id: true,
      shop: true,
      rules: true,
      batch: true,
      targetSnapshotCount: true,
      targetMirrorBatchId: true,
      targetingSnapshotMeta: true,
      executionIdentity: true,
    },
  });

  return { state: "claimed", history: claimedHistory };
}

async function markHistoryRetryable(historyId, shop, error, attempt, details = {}) {
  const history = await prisma.editHistory.findFirst({
    where: { id: historyId, shop },
    select: {
      error: true,
      batch: true,
    },
  });

  if (!history) return;

  const batch = history.batch && typeof history.batch === "object" ? history.batch : {};
  const waitingForShopifySlot = error.code === "shopify_bulk_busy";
  const nextExecutionState = waitingForShopifySlot
    ? OPERATION_LIFECYCLE_STATES.WAITING_FOR_SHOPIFY_SLOT
    : OPERATION_LIFECYCLE_STATES.QUEUED;

  await prisma.editHistory.updateMany({
    where: {
      id: historyId,
      shop,
      executionStateNormalized: normalizeEditHistoryExecutionState(
        BULK_EDIT_EXECUTION_STATES.DISPATCHING,
      ),
      bulkOperationId: null,
    },
    data: {
      status: "pending",
      statusNormalized: normalizeEditHistoryStatus("pending"),
      executionState: nextExecutionState,
      executionStateNormalized: normalizeEditHistoryExecutionState(
        nextExecutionState,
      ),
      failureStage: error.code || "retryable",
      error: appendExecutionError(
        history.error,
        buildExecutionError({
          code: error.code || "retryable_execution",
          stage: "dispatch",
          message: error.message,
          retryable: true,
          details: {
            ...details,
            attempt,
          },
        }),
      ),
      batch: {
        ...batch,
        lastRetryableErrorAt: new Date().toISOString(),
        lastRetryableErrorCode: error.code || "retryable_execution",
        ...(waitingForShopifySlot
          ? {
            waitingForShopifySlot: {
              at: new Date().toISOString(),
              reason: "active_shopify_bulk_operation",
              currentBulkOperation: error.details?.currentBulkOperation || null,
            },
          }
          : {}),
      },
    },
  });
}

async function markHistoryFailure(historyId, shop, error, attempt, executionId, source) {
  const history = await prisma.editHistory.findFirst({
    where: { id: historyId, shop },
    select: {
      error: true,
      batch: true,
    },
  });

  await prisma.editHistory.updateMany({
    where: { id: historyId, shop },
    data: {
      status: "failed",
      statusNormalized: normalizeEditHistoryStatus("failed"),
      executionState: BULK_EDIT_EXECUTION_STATES.FAILED,
      executionStateNormalized: normalizeEditHistoryExecutionState(
        BULK_EDIT_EXECUTION_STATES.FAILED,
      ),
      failureStage: error.code || "queue_execution",
      completedAt: new Date(),
      error: appendExecutionError(
        history?.error,
        buildExecutionError({
          code: error.code || "bulk_edit_worker_failure",
          stage: "queue_execution",
          message: error.message,
          retryable: false,
          details: {
            stack: error.stack || null,
            attempt,
            source,
            executionId,
          },
        }),
      ),
    },
  }).catch(() => {});
  const failedBatchId = history?.batch?.currentBatchId || null;
  if (failedBatchId) {
    await prisma.changeRecord.updateMany({
      where: {
        editHistoryId: historyId,
        shop,
        batchId: failedBatchId,
        status: "PENDING",
      },
      data: {
        status: "FAILED",
        failureCode: error.code || "bulk_edit_worker_failure",
        failureMessage: error.message,
      },
    }).catch(() => {});
  }
}

async function processBulkEdit(job) {
  const { historyId, shop, source = "bulk-edit", executionId = null } = job.data || {};
  assertNoRawTargetingPayload(job.data || {});
  const attempt = getJobAttempt(job);

  if (!historyId || !shop) {
    throw new Error("bulk edit job requires historyId and shop");
  }

  let shopLockKey = null;
  let budgetLeases = null;
  const leaseOwnerId = buildLeaseOwnerId("bulk-edit-worker");
  let leaseHeartbeat = null;

  try {
    const session = await getSession(shop);
    if (!session?.shop || session.shop !== shop) {
      throw new Error("Shop session not available for bulk edit execution");
    }

    const budget = await acquireShopifyExecutionBudget({
      shop,
      ownerId: historyId,
      queueName: QUEUE_NAME,
      destructive: true,
    });
    if (!budget.acquired) {
      throw new RetryableBulkEditError(
        `Shopify API budget unavailable: ${budget.reason}`,
        budget.reason || "shopify_api_budget_unavailable",
      );
    }
    budgetLeases = budget.leases;
    const operationLease = await acquireOperationLease({
      shop,
      namespace: "bulk_edit_execution",
      resourceId: historyId,
      ownerId: leaseOwnerId,
    });
    if (!operationLease.acquired) {
      throw new RetryableBulkEditError(
        "Bulk edit execution lease is already held",
        "operation_lease_conflict",
      );
    }
    leaseHeartbeat = setInterval(() => {
      heartbeatOperationLease({
        shop,
        namespace: "bulk_edit_execution",
        resourceId: historyId,
        ownerId: leaseOwnerId,
      }).catch(() => {});
    }, 60_000);

    const claimResult = await claimHistoryExecution(
      historyId,
      shop,
      executionId,
      job.id,
      attempt,
    );

    if (["terminal", "paused", "awaiting_shopify", "finalizing", "already_running", "not_claimed", "stale_dispatch_failed"].includes(claimResult.state)) {
      return { skipped: true, reason: claimResult.state, shop, historyId };
    }

    const currentBulkOperation = await getCurrentBulkOperationStatus(session);
    const { status } = currentBulkOperation || {};
    if (["CREATED", "RUNNING", "CANCELING"].includes(String(status || "").toUpperCase())) {
      throw new RetryableBulkEditError(
        "Another Shopify bulk operation is already running",
        "shopify_bulk_busy",
        { currentBulkOperation },
      );
    }

    await clearKeyCaches(`${shop}:fetchHistories`);
    await clearKeyCaches(`${shop}:historyDetails:${historyId}`);

    const service = new ProductBulkService(session);
    const history = claimResult.history;
    if (history?.cancelRequestedAt) {
      await prisma.editHistory.updateMany({
        where: {
          id: historyId,
          shop,
          bulkOperationId: null,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            BULK_EDIT_EXECUTION_STATES.DISPATCHING,
          ),
        },
        data: {
          status: "cancelled",
          statusNormalized: normalizeEditHistoryStatus("cancelled"),
          executionState: OPERATION_LIFECYCLE_STATES.CANCELLED,
          executionStateNormalized: normalizeEditHistoryExecutionState("CANCELLED"),
          cancelledAt: new Date(),
          completedAt: new Date(),
          failureStage: null,
        },
      });
      return { skipped: true, reason: "cancelled_before_dispatch", shop, historyId };
    }
    const expectedSnapshotChecksum = history?.targetingSnapshotMeta?.snapshotChecksum || null;
    if (expectedSnapshotChecksum && history?.targetMirrorBatchId) {
      const actualSnapshotChecksum = await computeTargetSnapshotChecksum({
        ownerType: "EDIT_HISTORY",
        ownerId: historyId,
        shop,
        mirrorBatchId: history.targetMirrorBatchId,
      });
      if (actualSnapshotChecksum !== expectedSnapshotChecksum) {
        const integrityError = new Error("FAILED_SNAPSHOT_INTEGRITY");
        integrityError.code = "FAILED_SNAPSHOT_INTEGRITY";
        throw integrityError;
      }
    }

    const {
      formattedProducts,
      changes,
      hasMore,
      lastProductId,
      nextRetryCursorIndex,
      batchId,
      batchTargetCount,
    } = await service._preparingBulkOperation({ historyId });
    assertUndoContractForDestructiveExecution(history.rules, changes);
    const conflictResolution = await applyPreMutationConflictPolicy({
      session,
      rules: history.rules,
      changes,
      formattedProducts,
      conflictPolicy: history?.batch?.conflictPolicy || null,
    });
    const safeChanges = conflictResolution.safeChanges;
    const safeFormattedProducts = conflictResolution.safeFormattedProducts;
    if (!safeFormattedProducts || safeChanges.length === 0) {
      throw Object.assign(new Error("CONFLICT_DETECTED"), {
        code: "CONFLICT_DETECTED",
        details: {
          policy: conflictResolution.effectivePolicy,
          conflicts: conflictResolution.conflicts,
        },
      });
    }
    if (conflictResolution.conflicts.length > 0) {
      await prisma.changeRecord.createMany({
        data: conflictResolution.conflicts.map((conflict) => ({
          editHistoryId: historyId,
          shop,
          targetType: String(conflict?.targetIdentity || "").startsWith("VARIANT:")
            ? "VARIANT"
            : "PRODUCT",
          targetIdentity: conflict.targetIdentity,
          productId: String(conflict.targetIdentity || "").replace(/^PRODUCT:/, ""),
          variantId: String(conflict.targetIdentity || "").startsWith("VARIANT:")
            ? String(conflict.targetIdentity || "").replace(/^VARIANT:/, "")
            : null,
          scope: "conflict",
          status: "CONFLICT",
          failureCode: "CONFLICT_DETECTED",
          failureMessage: JSON.stringify(conflict),
          batchId,
        })),
      }).catch(() => {});
    }

    if (!formattedProducts) {
      await prisma.editHistory.updateMany({
        where: {
          id: historyId,
          shop,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            BULK_EDIT_EXECUTION_STATES.DISPATCHING,
          ),
          bulkOperationId: null,
        },
        data: {
          status: "completed",
          statusNormalized: normalizeEditHistoryStatus("completed"),
          executionState: OPERATION_LIFECYCLE_STATES.COMPLETED,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            OPERATION_LIFECYCLE_STATES.COMPLETED,
          ),
          completedAt: new Date(),
          processedCount: history.targetSnapshotCount,
          processingBatchId: null,
          batch: {
            ...(history.batch || {}),
            hasMore: false,
            lastProductId: null,
            currentBatchTargetCount: 0,
            dispatchCompletedAt: new Date().toISOString(),
          },
        },
      });

      return {
        success: true,
        skipped: true,
        reason: "no_frozen_targets_remaining",
        shop,
        historyId,
      };
    }

    await prisma.changeRecord.deleteMany({
      where: {
        editHistoryId: historyId,
        shop,
        batchId,
      },
    });

    if (safeChanges.length > 0) {
      await prisma.changeRecord.createMany({
        data: safeChanges.map((change) =>
          toChangeRecordV2(change, history.targetMirrorBatchId),
        ),
      });
    }

    await clearKeyCaches(`${shop}:historyChanges:${historyId}`);

    const bulkSubmitStage = await beginEditHistoryStage({
      historyId,
      shop,
      stage: "bulkSubmit",
      executionId: executionId || history.executionIdentity || historyId,
      metadata: { batchId },
    });
    if (bulkSubmitStage.state === "completed" || bulkSubmitStage.state === "running") {
      return {
        skipped: true,
        reason: `bulk_submit_${bulkSubmitStage.state}`,
        shop,
        historyId,
      };
    }

    // Acquire write-catalog lock immediately before Shopify mutation dispatch.
    const lock = await acquireExclusiveShopWork({
      shop,
      activity: "bulk_edit_execution",
      worker: WORKER_NAME,
      queue: QUEUE_NAME,
      jobId: job.id,
      entityType: "editHistory",
      entityId: historyId,
      executionId,
      namespace: LOCK_NS.WRITE_CATALOG,
    });
    if (!lock.acquired) {
      throw new RetryableBulkEditError(
        "Another heavy job is already running for this shop",
        "shop_work_conflict",
      );
    }
    shopLockKey = lock.lockKey;

    let result;
    try {
      result = await service._bulkOperationHelper({
        historyId,
        executionId: executionId || history.executionIdentity || null,
        formattedProducts: safeFormattedProducts,
        fields: Array.isArray(history.rules)
          ? history.rules.map((rule) => rule?.field).filter(Boolean)
          : [],
        batchId,
        batchTargetCount,
        lastProductId,
        hasMore,
        nextRetryCursorIndex,
      });
    } catch (error) {
      await failEditHistoryStage({
        historyId,
        shop,
        stage: "bulkSubmit",
        retryable: true,
        checkpoint: { batchId },
        error: error.message,
      });
      throw error;
    }

    if (!result?.bulkOperation?.id) {
      throw new Error("Missing bulkOperationId in Shopify response");
    }

    const existingBatch = history.batch ?? {};
    const updatedBatch = {
      ...existingBatch,
      lastProductId,
      hasMore,
      currentBatchCount: safeChanges.length,
      currentBatchTargetCount: safeChanges.length,
      currentBatchId: batchId,
      retryCursorIndex: Number.isInteger(nextRetryCursorIndex)
        ? nextRetryCursorIndex
        : history.batch?.retryCursorIndex ?? 0,
      conflictPolicyApplied: conflictResolution.effectivePolicy,
      conflictDetectedCount: conflictResolution.conflicts.length,
      conflictFailures: conflictResolution.conflicts,
      cursor: {
        ownerType: "EDIT_HISTORY",
        ownerId: historyId,
        lastProcessedOrdinal: Number(lastProductId || 0),
        processedCount: Number(history.processedCount || 0) + Number(safeChanges.length || 0),
        successCount: Number(history.processedCount || 0) + Number(safeChanges.length || 0),
        failedCount: Number(history.batch?.cursor?.failedCount || 0),
        skippedCount:
          Number(history.batch?.cursor?.skippedCount || 0) +
          Number(conflictResolution.conflicts.length || 0),
      },
      dispatchCompletedAt: new Date().toISOString(),
      lastSubmittedBulkOperationId: result.bulkOperation.id,
    };

    const updated = await prisma.editHistory.updateMany({
      where: {
        id: historyId,
        shop,
        bulkOperationId: null,
        executionStateNormalized: normalizeEditHistoryExecutionState(
          BULK_EDIT_EXECUTION_STATES.DISPATCHING,
        ),
      },
      data: {
        bulkOperationId: result.bulkOperation.id,
        batch: updatedBatch,
        processingBatchId: batchId,
        failureStage: null,
        executionState: OPERATION_LIFECYCLE_STATES.SHOPIFY_BULK_SUBMITTED,
        executionStateNormalized: normalizeEditHistoryExecutionState(
          OPERATION_LIFECYCLE_STATES.SHOPIFY_BULK_SUBMITTED,
        ),
      },
    });

    if (!updated.count) {
      throw new Error("Bulk edit dispatch state could not be persisted safely");
    }
    await completeEditHistoryStage({
      historyId,
      shop,
      stage: "bulkSubmit",
      checkpoint: {
        batchId,
        bulkOperationId: result.bulkOperation.id,
      },
    });

    logger.info("Bulk edit worker queued Shopify bulk mutation", {
      worker: WORKER_NAME,
      queue: QUEUE_NAME,
      shop,
      jobId: job.id,
      historyId,
      executionId: executionId || history.executionIdentity || null,
      attempt,
      source,
      batchId,
      targetCount: batchTargetCount,
      changeCount: safeChanges.length,
      skippedCount: conflictResolution.conflicts.length,
      bulkOperationId: result.bulkOperation.id,
    });

    return {
      success: true,
      shop,
      historyId,
      bulkOperationId: result.bulkOperation.id,
      attempt,
    };
  } catch (err) {
    if (isRetryableError(err)) {
      await markHistoryRetryable(historyId, shop, err, attempt, {
        source,
        worker: WORKER_NAME,
        queue: QUEUE_NAME,
        jobId: job?.id || null,
      }).catch(() => {});
    } else {
      await markHistoryFailure(historyId, shop, err, attempt, executionId, source);

      await finalizeRecurringRunFromHistory({
        historyId,
        status: "FAILED",
        errorMessage: err.message,
      }).catch(() => {});

      await finalizeAutomaticProductRuleRunFromHistory({
        historyId,
        status: "FAILED",
        errorMessage: err.message,
        processingToken: await findAutomaticRuleProcessingToken(historyId),
      }).catch(() => {});

      await recordMirrorAnomaly({
        shop: shop || "unknown",
        severity: "high",
        type: "bulk_edit_worker_failure",
        entityType: "editHistory",
        entityId: historyId,
        message: err.message,
        details: {
          stage: "queue_execution",
          worker: WORKER_NAME,
          queue: QUEUE_NAME,
          jobId: job?.id || null,
          attempt,
          source,
          executionId,
        },
      }).catch(() => {});
    }

    await clearKeyCaches(`${shop}:fetchHistories`);
    await clearKeyCaches(`${shop}:historyDetails:${historyId}`);

      await logWorkerError({
      shop,
      err,
      source: "BulkEditWorker",
      metadata: {
        queue: QUEUE_NAME,
        worker: WORKER_NAME,
        jobId: job?.id || null,
        historyId,
        executionId,
        attempt,
        source,
        retryable: isRetryableError(err),
      },
      });

      if (!isRetryableError(err)) {
        await recordDeadLetterJob({
          shop,
          queueName: QUEUE_NAME,
          jobName: "bulk-edit",
          jobId: job?.id || null,
          payload: job?.data || null,
          error: err,
          attempts: attempt,
          recoverable: false,
          lastErrorCode: err?.code || null,
        }).catch(() => {});
      }

      throw err;
    } finally {
    if (leaseHeartbeat) {
      clearInterval(leaseHeartbeat);
    }
    await releaseOperationLease({
      shop,
      namespace: "bulk_edit_execution",
      resourceId: historyId,
      ownerId: leaseOwnerId,
    }).catch(() => {});
    await releaseExclusiveShopWork(shopLockKey);
    await releaseShopifyExecutionBudget({ shop, leases: budgetLeases });
  }
}

const bulkEditWorker = new Worker(QUEUE_NAME, processBulkEdit, {
  connection,
  concurrency: 1,
});

bulkEditWorker.on("completed", (job, result) => {
  logger.info("Bulk edit worker completed job", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    historyId: job?.data?.historyId,
    executionId: job?.data?.executionId || null,
    attempt: getJobAttempt(job),
    result,
  });
});

bulkEditWorker.on("failed", async (job, error) => {
  const shop = job?.data?.shop;
  const historyId = job?.data?.historyId;
  const executionId = job?.data?.executionId || null;

  logger.error("Bulk edit worker failed", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop,
    historyId,
    executionId,
    attempt: getJobAttempt(job),
    message: error.message,
  });

  if (isRetryExhausted(job)) {
    await recordRetryExhausted({
      job,
      shop,
      worker: WORKER_NAME,
      queue: QUEUE_NAME,
      entityType: "editHistory",
      entityId: historyId,
      executionId,
      message: "Bulk edit worker exhausted retries",
      details: {
        source: job?.data?.source || null,
      },
    });
  }
});

export default bulkEditWorker;
