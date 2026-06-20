import { db } from "./repositoryDb.js";

function safeText(value, max = 1000) {
  return String(value || "").slice(0, max);
}

function itemWhere({ bulkJobId, itemId, shop }) {
  return {
    id: itemId,
    shop,
    operationId: bulkJobId,
  };
}

export async function findBulkEditItemForApply({ bulkJobId, itemId, shop }) {
  return db.targetSnapshotItem.findFirst({
    where: itemWhere({ bulkJobId, itemId, shop }),
  });
}

export async function markBulkEditItemApplying({ bulkJobId, itemId, shop, attempt }) {
  return db.targetSnapshotItem.updateMany({
    where: {
      ...itemWhere({ bulkJobId, itemId, shop }),
      executionStatus: { in: ["PENDING", "FAILED"] },
    },
    data: {
      executionStatus: "SUBMITTED",
      executionAttemptCount: Number(attempt || 1),
      lastExecutionAttemptAt: new Date(),
      submittedAt: new Date(),
    },
  });
}

export async function markBulkEditItemDone({
  bulkJobId,
  itemId,
  shop,
  shopifyMetafieldId = null,
}) {
  return db.targetSnapshotItem.updateMany({
    where: itemWhere({ bulkJobId, itemId, shop }),
    data: {
      executionStatus: "SUCCEEDED",
      shopifyResultId: shopifyMetafieldId,
      shopifyErrorCode: null,
      shopifyErrorMessage: null,
      executedAt: new Date(),
    },
  });
}

export async function markBulkEditItemFailed({
  bulkJobId,
  itemId,
  shop,
  reason,
  message,
}) {
  return db.targetSnapshotItem.updateMany({
    where: itemWhere({ bulkJobId, itemId, shop }),
    data: {
      executionStatus: "FAILED",
      shopifyErrorCode: safeText(reason, 255),
      shopifyErrorMessage: safeText(message),
      executedAt: new Date(),
    },
  });
}

export async function markBulkEditItemDeferred({
  bulkJobId,
  itemId,
  shop,
  reason,
  message,
}) {
  return db.targetSnapshotItem.updateMany({
    where: itemWhere({ bulkJobId, itemId, shop }),
    data: {
      executionStatus: "PENDING",
      shopifyErrorCode: safeText(reason, 255),
      shopifyErrorMessage: safeText(message),
      lastExecutionAttemptAt: new Date(),
    },
  });
}

export async function incrementBulkEditParentCounters({
  bulkJobId,
  shop,
  completedDelta = 0,
  failedDelta = 0,
  deferredDelta = 0,
}) {
  return db.editHistory.updateMany({
    where: { id: bulkJobId, shop },
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