import { db } from "./repositoryDb.js";
import { createEnqueueIntent } from "../services/operationEnqueueIntentService.js";
import { joinSafeJobId } from "../utils/jobQueueUtils.js";
import { guardedEditHistoryUpdate } from "../services/operationTransitionGuards.js";

export const CLAIMABLE_STATES = [
  "PENDING",
  "DEFERRED",
];

export const UNCLAIMABLE_STATES = [
  "FAILED_TERMINAL",
  "SUCCEEDED",
  "CANCELLED",
  "CONFLICT",
  "APPLIED_UNVERIFIED",
  "RECONCILIATION_REQUIRED",
];

const MAX_INTERNAL_ID_LENGTH = 128;
const INTERNAL_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export function normalizeInternalId(value, code) {
  if (typeof value !== "string") {
    throw buildRepositoryError(code);
  }

  const normalized = value.trim();

  if (
    !normalized ||
    normalized.length > MAX_INTERNAL_ID_LENGTH ||
    !INTERNAL_ID_PATTERN.test(normalized)
  ) {
    throw buildRepositoryError(code);
  }

  return normalized;
}

export function normalizeFenceToken(value) {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw buildRepositoryError("INVALID_EXECUTION_LEASE_TOKEN");
    }
    return value;
  }

  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return BigInt(value);
  }

  throw buildRepositoryError("INVALID_EXECUTION_LEASE_TOKEN");
}

const DEFAULT_RETRY_DELAY_MS = 300_000;
const MIN_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

export function normalizeRetryDelay(value) {
  const delay =
    value === undefined || value === null
      ? DEFAULT_RETRY_DELAY_MS
      : Number(value);

  if (
    !Number.isSafeInteger(delay) ||
    delay < MIN_RETRY_DELAY_MS ||
    delay > MAX_RETRY_DELAY_MS
  ) {
    throw buildRepositoryError("INVALID_RETRY_DELAY");
  }

  return delay;
}

export const MAX_EXECUTION_ATTEMPTS = 6;
export const ITEM_LEASE_DURATION_MS = 10 * 60 * 1000;

function buildRepositoryError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function safeText(value, max = 1000) {
  if (!Number.isSafeInteger(max) || max < 1) {
    throw buildRepositoryError("INVALID_TEXT_LIMIT");
  }

  if (value === undefined || value === null) {
    return "";
  }

  return String(value)
    .trim()
    .slice(0, max);
}

function itemWhere({ bulkApplyJobId, itemId, shop }) {
  return {
    id: itemId,
    shop,
    operationId: bulkApplyJobId,
  };
}

export function isTransactionClient(client) {
  return Boolean(client && typeof client.$transaction !== "function");
}

export async function runInRepositoryTransaction(client, callback) {
  const targetClient = client || db;
  if (!targetClient) {
    throw buildRepositoryError("DATABASE_CLIENT_REQUIRED");
  }

  return isTransactionClient(targetClient)
    ? callback(targetClient)
    : targetClient.$transaction(callback);
}

export function parseTrustedMetafieldMutation(plannedMutation, item = {}) {
  const pm = plannedMutation && typeof plannedMutation === "object" ? plannedMutation : {};
  const ownerId =
    pm.ownerId ||
    item.variantId ||
    item.productId ||
    pm.id ||
    null;
  const namespace = pm.namespace || pm.metafield?.namespace || null;
  const key = pm.key || pm.metafield?.key || null;
  const type = pm.type || pm.metafield?.type || null;
  const value = pm.value !== undefined ? pm.value : pm.metafield?.value;

  return { ownerId, namespace, key, type, value };
}

export async function maybeFinalizeParentTx({ tx, bulkApplyJobId, shop }) {
  const parent = await tx.editHistory.findFirst({
    where: { id: bulkApplyJobId, shop },
    select: {
      id: true,
      shop: true,
      stateVersion: true,
      processedCount: true,
      totalItems: true,
      statusNormalized: true,
      snapshotSetId: true,
    },
  });

  if (!parent) return false;

  const terminalStatuses = ["COMPLETED", "PARTIALLY_COMPLETED", "CANCELLED", "FAILED"];
  if (terminalStatuses.includes(parent.statusNormalized)) {
    return false;
  }

  if (parent.totalItems > 0 && parent.processedCount >= parent.totalItems) {
    let succeeded = 0;
    let failed = 0;
    let conflict = 0;
    let cancelled = 0;
    let total = parent.totalItems;

    if (parent.snapshotSetId) {
      const snapshotSet = await tx.targetSnapshotSet.findFirst({
        where: { id: parent.snapshotSetId, shop },
        select: {
          itemCount: true,
          mutationSucceededCount: true,
          mutationFailedCount: true,
          mutationConflictCount: true,
          mutationCancelledCount: true,
        },
      });
      if (snapshotSet) {
        succeeded = snapshotSet.mutationSucceededCount || 0;
        failed = snapshotSet.mutationFailedCount || 0;
        conflict = snapshotSet.mutationConflictCount || 0;
        cancelled = snapshotSet.mutationCancelledCount || 0;
        total = snapshotSet.itemCount || parent.totalItems;
      }
    }

    let targetStatus = "PARTIALLY_COMPLETED";
    if (succeeded === total || (succeeded > 0 && failed === 0 && conflict === 0 && cancelled === 0)) {
      targetStatus = "COMPLETED";
    } else if (cancelled === total || (cancelled > 0 && succeeded === 0 && failed === 0 && conflict === 0)) {
      targetStatus = "CANCELLED";
    }

    const guardResult = await guardedEditHistoryUpdate({
      tx,
      id: parent.id,
      shop: parent.shop,
      expectedStateVersion: parent.stateVersion,
      data: {
        statusNormalized: targetStatus,
        status: targetStatus,
        executionStateNormalized: targetStatus === "COMPLETED" ? "COMPLETED" : "COMPLETED",
        completedAt: new Date(),
      },
    });

    return guardResult.success;
  }

  return false;
}

export async function claimBulkEditItemTx({
  tx,
  bulkApplyJobId,
  itemId,
  shop,
  ownerId,
  externalAttemptId,
  now = new Date(),
}) {
  if (!tx) throw buildRepositoryError("TRANSACTION_CLIENT_REQUIRED");

  const validJobId = normalizeInternalId(bulkApplyJobId, "INVALID_BULK_APPLY_JOB_ID");
  const validItemId = normalizeInternalId(itemId, "INVALID_ITEM_ID");
  const validShop = normalizeInternalId(shop, "INVALID_SHOP");
  const validOwnerId = normalizeInternalId(ownerId, "INVALID_OWNER_ID");
  const validAttemptId = normalizeInternalId(externalAttemptId, "INVALID_EXTERNAL_ATTEMPT_ID");

  const itemBefore = await tx.targetSnapshotItem.findFirst({
    where: {
      id: validItemId,
      shop: validShop,
      operationId: validJobId,
    },
    select: { executionStatus: true, snapshotSetId: true },
  });

  if (!itemBefore) return null;
  const prevStatus = itemBefore.executionStatus;

  const leaseExpiresAt = new Date(now.getTime() + ITEM_LEASE_DURATION_MS);

  const claimed = await tx.targetSnapshotItem.updateMany({
    where: {
      id: validItemId,
      shop: validShop,
      operationId: validJobId,
      executionAttemptCount: {
        lt: MAX_EXECUTION_ATTEMPTS,
      },
      OR: [
        {
          executionStatus: "PENDING",
        },
        {
          executionStatus: "DEFERRED",
          retryable: true,
          nextAttemptAt: {
            lte: now,
          },
        },
      ],
    },
    data: {
      executionStatus: "CLAIMED",
      executionOwnerId: validOwnerId,
      externalAttemptId: validAttemptId,
      executionLeaseAt: now,
      executionLeaseExpiresAt: leaseExpiresAt,
      executionLeaseToken: {
        increment: 1,
      },
      executionAttemptCount: {
        increment: 1,
      },
      nextAttemptAt: null,
      shopifyErrorCode: null,
      shopifyErrorMessage: null,
    },
  });

  if (claimed.count !== 1) {
    return null;
  }

  if (itemBefore.snapshotSetId) {
    const counterDecrementField = prevStatus === "DEFERRED" ? "mutationDeferredCount" : "mutationPendingCount";
    await tx.targetSnapshotSet.updateMany({
      where: { id: itemBefore.snapshotSetId, shop: validShop },
      data: {
        [counterDecrementField]: { decrement: 1 },
        mutationClaimedCount: { increment: 1 },
      },
    });
  }

  const item = await tx.targetSnapshotItem.findFirst({
    where: {
      id: validItemId,
      shop: validShop,
      operationId: validJobId,
      executionStatus: "CLAIMED",
      executionOwnerId: validOwnerId,
      externalAttemptId: validAttemptId,
    },
    select: {
      id: true,
      shop: true,
      operationId: true,
      snapshotSetId: true,
      productId: true,
      variantId: true,
      plannedMutation: true,
      plannedValueHash: true,
      executionAttemptCount: true,
      executionLeaseToken: true,
      executionLeaseExpiresAt: true,
    },
  });

  if (!item) {
    throw buildRepositoryError("ITEM_CLAIM_CONTEXT_MISSING");
  }

  return {
    ...item,
    executionLeaseToken: item.executionLeaseToken?.toString() ?? null,
  };
}

export async function claimBulkEditItem(args) {
  const client = args?.tx || args?.dbClient || db;
  return runInRepositoryTransaction(client, (tx) =>
    claimBulkEditItemTx({
      ...args,
      tx,
    }),
  );
}

export async function markItemApplyingTx({
  tx,
  bulkApplyJobId,
  itemId,
  shop,
  executionOwnerId,
  externalAttemptId,
  executionLeaseToken,
  now = new Date(),
}) {
  if (!tx) throw buildRepositoryError("TRANSACTION_CLIENT_REQUIRED");

  const validJobId = normalizeInternalId(bulkApplyJobId, "INVALID_BULK_APPLY_JOB_ID");
  const validItemId = normalizeInternalId(itemId, "INVALID_ITEM_ID");
  const validShop = normalizeInternalId(shop, "INVALID_SHOP");
  const validOwnerId = normalizeInternalId(executionOwnerId, "INVALID_OWNER_ID");
  const validAttemptId = normalizeInternalId(externalAttemptId, "INVALID_EXTERNAL_ATTEMPT_ID");
  const validFenceToken = normalizeFenceToken(executionLeaseToken);

  const updated = await tx.targetSnapshotItem.updateMany({
    where: {
      id: validItemId,
      shop: validShop,
      operationId: validJobId,
      executionStatus: "CLAIMED",
      executionOwnerId: validOwnerId,
      externalAttemptId: validAttemptId,
      executionLeaseToken: validFenceToken,
      executionLeaseExpiresAt: {
        gt: now,
      },
    },
    data: {
      executionStatus: "APPLYING",
      applyStartedAt: now,
    },
  });

  if (updated.count !== 1) {
    throw buildRepositoryError("ITEM_APPLY_OWNERSHIP_LOST");
  }

  const item = await tx.targetSnapshotItem.findFirst({
    where: { id: validItemId, shop: validShop },
    select: { snapshotSetId: true },
  });

  if (item?.snapshotSetId) {
    await tx.targetSnapshotSet.updateMany({
      where: { id: item.snapshotSetId, shop: validShop },
      data: {
        mutationClaimedCount: { decrement: 1 },
        mutationApplyingCount: { increment: 1 },
      },
    });
  }

  return true;
}

export async function markItemApplying(args) {
  const client = args?.tx || args?.dbClient || db;
  return runInRepositoryTransaction(client, (tx) =>
    markItemApplyingTx({
      ...args,
      tx,
    }),
  );
}

export async function markItemAppliedUnverifiedTx({
  tx,
  bulkApplyJobId,
  itemId,
  shop,
  executionOwnerId,
  externalAttemptId,
  executionLeaseToken,
  shopifyResultId,
  now = new Date(),
}) {
  if (!tx) throw buildRepositoryError("TRANSACTION_CLIENT_REQUIRED");

  const validJobId = normalizeInternalId(bulkApplyJobId, "INVALID_BULK_APPLY_JOB_ID");
  const validItemId = normalizeInternalId(itemId, "INVALID_ITEM_ID");
  const validShop = normalizeInternalId(shop, "INVALID_SHOP");
  const validOwnerId = normalizeInternalId(executionOwnerId, "INVALID_OWNER_ID");
  const validAttemptId = normalizeInternalId(externalAttemptId, "INVALID_EXTERNAL_ATTEMPT_ID");
  const validFenceToken = normalizeFenceToken(executionLeaseToken);

  const updated = await tx.targetSnapshotItem.updateMany({
    where: {
      id: validItemId,
      shop: validShop,
      operationId: validJobId,
      executionStatus: "APPLYING",
      executionOwnerId: validOwnerId,
      externalAttemptId: validAttemptId,
      executionLeaseToken: validFenceToken,
    },
    data: {
      executionStatus: "APPLIED_UNVERIFIED",
      shopifyResultId: safeText(shopifyResultId, 255),
      shopifyAppliedAt: now,
    },
  });

  if (updated.count !== 1) {
    throw buildRepositoryError("ITEM_APPLIED_RECORDING_CONFLICT");
  }

  return true;
}

export async function markItemAppliedUnverified(args) {
  const client = args?.tx || args?.dbClient || db;
  return runInRepositoryTransaction(client, (tx) =>
    markItemAppliedUnverifiedTx({
      ...args,
      tx,
    }),
  );
}

export async function claimOrCreateAppliedMutationTx({
  tx,
  shop,
  operationId,
  snapshotItemId,
  mutationHash,
  externalAttemptId,
  now = new Date(),
}) {
  if (!tx) throw buildRepositoryError("TRANSACTION_CLIENT_REQUIRED");

  const validShop = normalizeInternalId(shop, "INVALID_SHOP");
  const validOpId = normalizeInternalId(operationId, "INVALID_BULK_APPLY_JOB_ID");
  const validItemId = normalizeInternalId(snapshotItemId, "INVALID_ITEM_ID");
  const validAttemptId = normalizeInternalId(externalAttemptId, "INVALID_EXTERNAL_ATTEMPT_ID");
  const hashStr = String(mutationHash || "").trim();
  if (!hashStr) throw buildRepositoryError("INVALID_MUTATION_HASH");

  const existing = await tx.appliedMutation.findFirst({
    where: {
      shop: validShop,
      snapshotItemId: validItemId,
      mutationHash: hashStr,
    },
  });

  if (existing) {
    return existing;
  }

  return tx.appliedMutation.create({
    data: {
      shop: validShop,
      operationId: validOpId,
      snapshotItemId: validItemId,
      mutationHash: hashStr,
      externalAttemptId: validAttemptId,
      status: "CLAIMED",
      createdAt: now,
    },
  });
}

export async function claimOrCreateAppliedMutation(args) {
  const client = args?.tx || args?.dbClient || db;
  return runInRepositoryTransaction(client, (tx) =>
    claimOrCreateAppliedMutationTx({
      ...args,
      tx,
    }),
  );
}

export async function completeItemAndParentTx({
  tx,
  bulkApplyJobId,
  itemId,
  shop,
  executionOwnerId,
  externalAttemptId,
  executionLeaseToken,
  plannedValueHash,
  verifiedCurrentValueHash,
  shopifyMetafieldId = null,
  now = new Date(),
}) {
  if (!tx) throw buildRepositoryError("TRANSACTION_CLIENT_REQUIRED");

  const validJobId = normalizeInternalId(bulkApplyJobId, "INVALID_BULK_APPLY_JOB_ID");
  const validItemId = normalizeInternalId(itemId, "INVALID_ITEM_ID");
  const validShop = normalizeInternalId(shop, "INVALID_SHOP");
  const validOwnerId = normalizeInternalId(executionOwnerId, "INVALID_OWNER_ID");
  const validAttemptId = normalizeInternalId(externalAttemptId, "INVALID_EXTERNAL_ATTEMPT_ID");
  if (executionLeaseToken !== undefined && executionLeaseToken !== null) {
    normalizeFenceToken(executionLeaseToken);
  }

  const item = await tx.targetSnapshotItem.findFirst({
    where: {
      id: validItemId,
      shop: validShop,
      operationId: validJobId,
      executionOwnerId: validOwnerId,
      externalAttemptId: validAttemptId,
      executionStatus: { in: ["APPLIED_UNVERIFIED", "APPLYING", "CLAIMED"] },
    },
    select: {
      id: true,
      snapshotSetId: true,
      plannedValueHash: true,
      executionStatus: true,
    },
  });

  if (!item) return false;

  const prevStatus = item.executionStatus;
  const hashToUse = plannedValueHash || item.plannedValueHash;

  const updated = await tx.targetSnapshotItem.updateMany({
    where: {
      id: validItemId,
      shop: validShop,
      operationId: validJobId,
      executionOwnerId: validOwnerId,
      externalAttemptId: validAttemptId,
      executionStatus: { in: ["APPLIED_UNVERIFIED", "APPLYING", "CLAIMED"] },
    },
    data: {
      executionStatus: "SUCCEEDED",
      writtenValueHash: hashToUse || null,
      currentValueHash: verifiedCurrentValueHash || hashToUse || null,
      verifiedAt: now,
      executedAt: now,
      shopifyResultId: shopifyMetafieldId,
    },
  });

  if (updated.count !== 1) return false;

  if (item.snapshotSetId) {
    const counterDecrementField =
      prevStatus === "APPLYING" || prevStatus === "APPLIED_UNVERIFIED"
        ? "mutationApplyingCount"
        : "mutationClaimedCount";

    await tx.targetSnapshotSet.updateMany({
      where: {
        id: item.snapshotSetId,
        shop: validShop,
      },
      data: {
        [counterDecrementField]: { decrement: 1 },
        mutationSucceededCount: { increment: 1 },
      },
    });
  }

  const historyUpdate = await tx.editHistory.updateMany({
    where: { id: validJobId, shop: validShop },
    data: {
      processedCount: { increment: 1 },
    },
  });

  if (historyUpdate.count !== 1) {
    throw buildRepositoryError("EDIT_HISTORY_PROCESSED_COUNT_UPDATE_FAILED");
  }

  await maybeFinalizeParentTx({ tx, bulkApplyJobId: validJobId, shop: validShop });

  return true;
}

export async function completeItemAndParent(args) {
  const client = args?.tx || args?.dbClient || db;
  return runInRepositoryTransaction(client, (tx) =>
    completeItemAndParentTx({
      ...args,
      tx,
    }),
  );
}

export async function findBulkEditItemForApply({
  bulkApplyJobId,
  itemId,
  shop,
  tx = db,
}) {
  const validJobId = normalizeInternalId(bulkApplyJobId, "INVALID_BULK_APPLY_JOB_ID");
  const validItemId = normalizeInternalId(itemId, "INVALID_ITEM_ID");
  const validShop = normalizeInternalId(shop, "INVALID_SHOP");
  const targetClient = tx || db;

  return targetClient.targetSnapshotItem.findFirst({
    where: itemWhere({
      bulkApplyJobId: validJobId,
      itemId: validItemId,
      shop: validShop,
    }),
    select: {
      id: true,
      shop: true,
      operationId: true,
      snapshotSetId: true,
      productId: true,
      variantId: true,
      plannedMutation: true,
      plannedValueHash: true,
      executionStatus: true,
      executionAttemptCount: true,
      nextAttemptAt: true,
    },
  });
}

export async function markItemFailedTerminalTx({
  tx,
  bulkApplyJobId,
  itemId,
  shop,
  executionOwnerId,
  externalAttemptId,
  executionLeaseToken,
  reason,
  message,
}) {
  if (!tx) throw buildRepositoryError("TRANSACTION_CLIENT_REQUIRED");

  const validJobId = normalizeInternalId(bulkApplyJobId, "INVALID_BULK_APPLY_JOB_ID");
  const validItemId = normalizeInternalId(itemId, "INVALID_ITEM_ID");
  const validShop = normalizeInternalId(shop, "INVALID_SHOP");
  const validOwnerId = normalizeInternalId(executionOwnerId, "INVALID_OWNER_ID");
  const validAttemptId = normalizeInternalId(externalAttemptId, "INVALID_EXTERNAL_ATTEMPT_ID");

  const item = await tx.targetSnapshotItem.findFirst({
    where: {
      id: validItemId,
      shop: validShop,
      operationId: validJobId,
      executionOwnerId: validOwnerId,
      externalAttemptId: validAttemptId,
      executionStatus: { in: ["CLAIMED", "APPLYING", "SUBMITTED"] },
    },
    select: { id: true, snapshotSetId: true, executionStatus: true },
  });

  if (!item) return false;

  const prevStatus = item.executionStatus;

  const updated = await tx.targetSnapshotItem.updateMany({
    where: {
      id: validItemId,
      shop: validShop,
      operationId: validJobId,
      executionOwnerId: validOwnerId,
      externalAttemptId: validAttemptId,
      executionStatus: { in: ["CLAIMED", "APPLYING", "SUBMITTED"] },
    },
    data: {
      executionStatus: "FAILED_TERMINAL",
      shopifyErrorCode: safeText(reason, 255),
      shopifyErrorMessage: safeText(message),
      executedAt: new Date(),
    },
  });

  if (updated.count !== 1) return false;

  if (item.snapshotSetId) {
    const counterDecrementField =
      prevStatus === "APPLYING"
        ? "mutationApplyingCount"
        : prevStatus === "CLAIMED"
          ? "mutationClaimedCount"
          : "mutationSubmittedCount";

    await tx.targetSnapshotSet.updateMany({
      where: { id: item.snapshotSetId, shop: validShop },
      data: {
        [counterDecrementField]: { decrement: 1 },
        mutationFailedCount: { increment: 1 },
      },
    });
  }

  const historyUpdate = await tx.editHistory.updateMany({
    where: { id: validJobId, shop: validShop },
    data: {
      processedCount: { increment: 1 },
    },
  });

  if (historyUpdate.count !== 1) {
    throw buildRepositoryError("EDIT_HISTORY_PROCESSED_COUNT_UPDATE_FAILED");
  }

  await maybeFinalizeParentTx({ tx, bulkApplyJobId: validJobId, shop: validShop });

  return true;
}

export async function markItemFailedTerminal(args) {
  const client = args?.tx || args?.dbClient || db;
  return runInRepositoryTransaction(client, (tx) =>
    markItemFailedTerminalTx({
      ...args,
      tx,
    }),
  );
}

export async function markBulkEditItemFailedTx(args) {
  return markItemFailedTerminalTx(args);
}

export async function markBulkEditItemFailed(args) {
  return markItemFailedTerminal(args);
}

export async function markBulkEditItemDeferredTx({
  tx,
  bulkApplyJobId,
  itemId,
  shop,
  executionOwnerId,
  externalAttemptId,
  executionLeaseToken,
  retryAfterMs,
  now = new Date(),
}) {
  if (!tx) throw buildRepositoryError("TRANSACTION_CLIENT_REQUIRED");

  const validJobId = normalizeInternalId(bulkApplyJobId, "INVALID_BULK_APPLY_JOB_ID");
  const validItemId = normalizeInternalId(itemId, "INVALID_ITEM_ID");
  const validShop = normalizeInternalId(shop, "INVALID_SHOP");
  const validOwnerId = normalizeInternalId(executionOwnerId, "INVALID_OWNER_ID");
  const validAttemptId = normalizeInternalId(externalAttemptId, "INVALID_EXTERNAL_ATTEMPT_ID");
  const validFenceToken = normalizeFenceToken(executionLeaseToken);
  const validDelay = normalizeRetryDelay(retryAfterMs);

  const item = await tx.targetSnapshotItem.findFirst({
    where: {
      id: validItemId,
      shop: validShop,
      operationId: validJobId,
      executionOwnerId: validOwnerId,
      externalAttemptId: validAttemptId,
      executionLeaseToken: validFenceToken,
      executionStatus: { in: ["CLAIMED", "APPLYING", "APPLIED_UNVERIFIED", "SUBMITTED", "RECONCILIATION_REQUIRED"] },
    },
    select: { id: true, snapshotSetId: true, executionStatus: true, retryGeneration: true },
  });

  if (!item) {
    throw buildRepositoryError("ITEM_DEFER_OWNERSHIP_LOST");
  }

  const prevStatus = item.executionStatus;
  const nextAttemptAt = new Date(now.getTime() + validDelay);

  const deferred = await tx.targetSnapshotItem.updateMany({
    where: {
      id: validItemId,
      shop: validShop,
      operationId: validJobId,
      executionOwnerId: validOwnerId,
      externalAttemptId: validAttemptId,
      executionLeaseToken: validFenceToken,
    },
    data: {
      executionStatus: "DEFERRED",
      retryable: true,
      nextAttemptAt,
      retryGeneration: { increment: 1 },
      shopifyErrorCode: "LONG_RETRY_AFTER",
      executionOwnerId: null,
      externalAttemptId: null,
      executionLeaseToken: null,
      executionLeaseAt: null,
      executionLeaseExpiresAt: null,
      lastHeartbeatAt: null,
    },
  });

  if (deferred.count !== 1) {
    throw buildRepositoryError("ITEM_DEFER_OWNERSHIP_LOST");
  }

  const updatedItem = await tx.targetSnapshotItem.findFirst({
    where: { id: validItemId, shop: validShop },
    select: { retryGeneration: true },
  });

  const nextGeneration = updatedItem?.retryGeneration ?? ((item.retryGeneration || 0) + 1);

  if (item.snapshotSetId) {
    const counterDecrementField =
      prevStatus === "APPLYING" || prevStatus === "APPLIED_UNVERIFIED"
        ? "mutationApplyingCount"
        : prevStatus === "CLAIMED"
          ? "mutationClaimedCount"
          : "mutationSubmittedCount";

    await tx.targetSnapshotSet.updateMany({
      where: { id: item.snapshotSetId, shop: validShop },
      data: {
        [counterDecrementField]: { decrement: 1 },
        mutationDeferredCount: { increment: 1 },
      },
    });
  }

  const dispatchDedupeKey = [
    "bulk-item-retry",
    validShop,
    validJobId,
    validItemId,
    nextGeneration,
  ].join(":");

  await createEnqueueIntent({
    tx,
    shop: validShop,
    queueRoutingKey: "BULK_EDIT_ITEM_APPLY",
    queueJobName: "apply-metafield-item",
    payload: { shop: validShop, bulkApplyJobId: validJobId, itemId: validItemId },
    options: {
      jobId: joinSafeJobId(
        "bulk-edit-item",
        validShop,
        validJobId,
        validItemId,
        nextGeneration,
      ),
      delay: validDelay,
    },
    dispatchDedupeKey,
  });

  return true;
}

export async function markBulkEditItemDeferred(args) {
  const client = args?.tx || args?.dbClient || db;
  return runInRepositoryTransaction(client, (tx) =>
    markBulkEditItemDeferredTx({
      ...args,
      tx,
    }),
  );
}
