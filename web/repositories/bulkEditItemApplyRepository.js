import { db } from "./repositoryDb.js";

function safeText(value, max = 1000) {
  return String(value || "").slice(0, max);
}

function itemWhere({ bulkApplyJobId, itemId, shop }) {
  return {
    id: itemId,
    shop,
    operationId: bulkApplyJobId,
  };
}

const MUTATION_COUNTER_FIELD = Object.freeze({
  PENDING: "mutationPendingCount",
  SUBMITTED: "mutationSubmittedCount",
  SUCCEEDED: "mutationSucceededCount",
  FAILED: "mutationFailedCount",
  SKIPPED: "mutationSkippedCount",
});

async function transitionMutationStatus({
  bulkApplyJobId,
  itemId,
  shop,
  allowedFrom,
  to,
  data = {},
}) {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT "id", "snapshotSetId", "executionStatus"::text AS "executionStatus"
      FROM "TargetSnapshotItem"
      WHERE "id" = ${itemId} AND "shop" = ${shop} AND "operationId" = ${bulkApplyJobId}
      FOR UPDATE
    `;
    const current = rows[0] || null;
    const from = String(current?.executionStatus || "").toUpperCase();
    if (!current || !allowedFrom.includes(from)) return { count: 0 };

    await tx.targetSnapshotItem.update({
      where: { id: current.id },
      data: { ...data, executionStatus: to },
    });

    if (from !== to) {
      const fromCounter = MUTATION_COUNTER_FIELD[from];
      const toCounter = MUTATION_COUNTER_FIELD[to];
      if (!fromCounter || !toCounter) {
        throw new Error(`UNSUPPORTED_TARGET_MUTATION_TRANSITION:${from}:${to}`);
      }
      await tx.targetSnapshotSet.updateMany({
        where: { id: current.snapshotSetId, shop },
        data: {
          [fromCounter]: { decrement: 1 },
          [toCounter]: { increment: 1 },
        },
      });
    }

    return { count: 1 };
  });
}

export async function findBulkEditItemForApply({ bulkApplyJobId, itemId, shop }) {
  return db.targetSnapshotItem.findFirst({
    where: itemWhere({ bulkApplyJobId, itemId, shop }),
  });
}

export async function markBulkEditItemApplying({ bulkApplyJobId, itemId, shop, attempt }) {
  return transitionMutationStatus({
    bulkApplyJobId,
    itemId,
    shop,
    allowedFrom: ["PENDING", "FAILED"],
    to: "SUBMITTED",
    data: {
      verificationStatus: null,
      executionAttemptCount: Number(attempt || 1),
      lastExecutionAttemptAt: new Date(),
      submittedAt: new Date(),
    },
  });
}

export async function markBulkEditItemDone({
  bulkApplyJobId,
  itemId,
  shop,
  shopifyMetafieldId = null,
}) {
  return transitionMutationStatus({
    bulkApplyJobId,
    itemId,
    shop,
    allowedFrom: ["SUBMITTED"],
    to: "SUCCEEDED",
    data: {
      verificationStatus: null,
      shopifyResultId: shopifyMetafieldId,
      shopifyErrorCode: null,
      shopifyErrorMessage: null,
      executedAt: new Date(),
    },
  });
}

export async function markBulkEditItemFailed({
  bulkApplyJobId,
  itemId,
  shop,
  reason,
  message,
}) {
  return transitionMutationStatus({
    bulkApplyJobId,
    itemId,
    shop,
    allowedFrom: ["SUBMITTED"],
    to: "FAILED",
    data: {
      verificationStatus: null,
      shopifyErrorCode: safeText(reason, 255),
      shopifyErrorMessage: safeText(message),
      executedAt: new Date(),
    },
  });
}

export async function markBulkEditItemDeferred({
  bulkApplyJobId,
  itemId,
  shop,
  reason,
  message,
}) {
  return transitionMutationStatus({
    bulkApplyJobId,
    itemId,
    shop,
    allowedFrom: ["SUBMITTED"],
    to: "PENDING",
    data: {
      verificationStatus: null,
      shopifyErrorCode: safeText(reason, 255),
      shopifyErrorMessage: safeText(message),
      lastExecutionAttemptAt: new Date(),
    },
  });
}

export async function incrementBulkEditParentCounters({
  bulkApplyJobId,
  shop,
  completedDelta = 0,
  failedDelta = 0,
  deferredDelta = 0,
}) {
  return db.editHistory.updateMany({
    where: { id: bulkApplyJobId, shop },
    data: {
      processedCount: {
        increment:
          Number(completedDelta || 0) +
          Number(failedDelta || 0) +
          Number(deferredDelta || 0),
      },
    },
  });
}
