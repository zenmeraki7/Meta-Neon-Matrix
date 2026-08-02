import test from "node:test";
import assert from "node:assert/strict";
import {
  claimBulkEditItem,
  completeItemAndParent,
  parseTrustedMetafieldMutation,
  markBulkEditItemDeferred,
} from "./repositories/bulkEditItemApplyRepository.js";

function createFakeBulkApplyDb() {
  const snapshotItems = new Map();
  const snapshotSets = new Map();
  const editHistories = new Map();
  const enqueueIntents = [];

  const fakeTx = {
    targetSnapshotItem: {
      async updateMany({ where, data }) {
        let count = 0;
        for (const [id, item] of snapshotItems.entries()) {
          if (where.id && item.id !== where.id) continue;
          if (where.shop && item.shop !== where.shop) continue;
          if (where.operationId && item.operationId !== where.operationId) continue;
          if (where.executionStatus?.in && !where.executionStatus.in.includes(item.executionStatus)) continue;
          if (where.executionStatus && typeof where.executionStatus === "string" && item.executionStatus !== where.executionStatus) continue;
          if (where.executionOwnerId && item.executionOwnerId !== where.executionOwnerId) continue;
          if (where.externalAttemptId && item.externalAttemptId !== where.externalAttemptId) continue;

          const updated = { ...item };
          for (const [key, val] of Object.entries(data)) {
            if (val && typeof val === "object" && val.increment) {
              updated[key] = (updated[key] || 0) + val.increment;
            } else {
              updated[key] = val;
            }
          }
          snapshotItems.set(id, updated);
          count++;
        }
        return { count };
      },
      async findFirst({ where, select }) {
        for (const item of snapshotItems.values()) {
          if (where.id && item.id !== where.id) continue;
          if (where.shop && item.shop !== where.shop) continue;
          if (where.operationId && item.operationId !== where.operationId) continue;
          if (where.executionStatus && item.executionStatus !== where.executionStatus) continue;
          if (where.executionOwnerId && item.executionOwnerId !== where.executionOwnerId) continue;
          if (where.externalAttemptId && item.externalAttemptId !== where.externalAttemptId) continue;

          if (select) {
            const selected = {};
            for (const key of Object.keys(select)) {
              if (select[key]) selected[key] = item[key];
            }
            return selected;
          }
          return item;
        }
        return null;
      },
    },
    targetSnapshotSet: {
      async updateMany({ where, data }) {
        let count = 0;
        for (const [id, set] of snapshotSets.entries()) {
          if (where.id && set.id !== where.id) continue;
          if (where.shop && set.shop !== where.shop) continue;

          const updated = { ...set };
          for (const [key, val] of Object.entries(data)) {
            if (val && typeof val === "object" && val.increment) {
              updated[key] = (updated[key] || 0) + val.increment;
            } else if (val && typeof val === "object" && val.decrement) {
              updated[key] = (updated[key] || 0) - val.decrement;
            } else {
              updated[key] = val;
            }
          }
          snapshotSets.set(id, updated);
          count++;
        }
        return { count };
      },
    },
    editHistory: {
      async updateMany({ where, data }) {
        let count = 0;
        for (const [id, hist] of editHistories.entries()) {
          if (where.id && hist.id !== where.id) continue;
          if (where.shop && hist.shop !== where.shop) continue;

          const updated = { ...hist };
          for (const [key, val] of Object.entries(data)) {
            if (val && typeof val === "object" && val.increment) {
              updated[key] = (updated[key] || 0) + val.increment;
            } else {
              updated[key] = val;
            }
          }
          editHistories.set(id, updated);
          count++;
        }
        return { count };
      },
    },
    operationEnqueueIntent: {
      async createMany({ data }) {
        enqueueIntents.push(...data);
        return { count: data.length };
      },
      async findFirst() {
        return enqueueIntents.at(-1) || null;
      },
    },
  };

  return {
    snapshotItems,
    snapshotSets,
    editHistories,
    enqueueIntents,
    dbClient: {
      async $transaction(cb) {
        return cb(fakeTx);
      },
    },
  };
}

test("parseTrustedMetafieldMutation correctly extracts mutation fields", () => {
  const pm = {
    ownerId: "gid://shopify/Product/101",
    namespace: "custom",
    key: "seo_title",
    type: "single_line_text_field",
    value: "Awesome Product",
  };
  const result = parseTrustedMetafieldMutation(pm, { productId: "gid://shopify/Product/101" });
  assert.equal(result.ownerId, "gid://shopify/Product/101");
  assert.equal(result.namespace, "custom");
  assert.equal(result.key, "seo_title");
  assert.equal(result.type, "single_line_text_field");
  assert.equal(result.value, "Awesome Product");
});

test("claimBulkEditItem atomically claims PENDING item and blocks concurrent job claim", async () => {
  const { snapshotItems, dbClient } = createFakeBulkApplyDb();

  snapshotItems.set("item-1", {
    id: "item-1",
    shop: "store.myshopify.com",
    operationId: "job-123",
    executionStatus: "PENDING",
    productId: "gid://shopify/Product/1",
    plannedMutation: {
      namespace: "custom",
      key: "badge",
      type: "single_line_text_field",
      value: "Sale",
    },
  });

  const claim1 = await claimBulkEditItem({
    bulkApplyJobId: "job-123",
    itemId: "item-1",
    shop: "store.myshopify.com",
    ownerId: "job:1001",
    externalAttemptId: "attempt-aaa",
    dbClient,
  });

  assert.ok(claim1, "Job 1 should successfully claim item");
  assert.equal(claim1.id, "item-1");
  assert.deepEqual(claim1.plannedMutation.key, "badge");

  const itemState = snapshotItems.get("item-1");
  assert.equal(itemState.executionStatus, "SUBMITTED");
  assert.equal(itemState.executionOwnerId, "job:1001");
  assert.equal(itemState.externalAttemptId, "attempt-aaa");

  // Job 2 attempts to claim the same item
  const claim2 = await claimBulkEditItem({
    bulkApplyJobId: "job-123",
    itemId: "item-1",
    shop: "store.myshopify.com",
    ownerId: "job:1002",
    externalAttemptId: "attempt-bbb",
    dbClient,
  });

  assert.equal(claim2, null, "Job 2 claim must fail (return null)");
});

test("completeItemAndParent updates item to SUCCEEDED and increments parent processedCount exactly once", async () => {
  const { snapshotItems, snapshotSets, editHistories, dbClient } = createFakeBulkApplyDb();

  snapshotItems.set("item-2", {
    id: "item-2",
    shop: "store.myshopify.com",
    operationId: "job-123",
    snapshotSetId: "set-1",
    executionStatus: "SUBMITTED",
    executionOwnerId: "job:1001",
    externalAttemptId: "attempt-aaa",
  });

  snapshotSets.set("set-1", {
    id: "set-1",
    shop: "store.myshopify.com",
    mutationSubmittedCount: 1,
    mutationSucceededCount: 0,
  });

  editHistories.set("job-123", {
    id: "job-123",
    shop: "store.myshopify.com",
    processedCount: 0,
  });

  // Wrong owner token attempt should fail
  const failedComplete = await completeItemAndParent({
    bulkApplyJobId: "job-123",
    itemId: "item-2",
    shop: "store.myshopify.com",
    executionOwnerId: "wrong-owner",
    externalAttemptId: "attempt-aaa",
    shopifyMetafieldId: "meta-999",
    dbClient,
  });

  assert.equal(failedComplete, false, "Complete must fail when owner mismatch");
  assert.equal(editHistories.get("job-123").processedCount, 0);

  // Correct owner token complete
  const okComplete = await completeItemAndParent({
    bulkApplyJobId: "job-123",
    itemId: "item-2",
    shop: "store.myshopify.com",
    executionOwnerId: "job:1001",
    externalAttemptId: "attempt-aaa",
    shopifyMetafieldId: "meta-999",
    dbClient,
  });

  assert.equal(okComplete, true);
  assert.equal(snapshotItems.get("item-2").executionStatus, "SUCCEEDED");
  assert.equal(snapshotItems.get("item-2").shopifyResultId, "meta-999");
  assert.equal(snapshotSets.get("set-1").mutationSubmittedCount, 0);
  assert.equal(snapshotSets.get("set-1").mutationSucceededCount, 1);
  assert.equal(editHistories.get("job-123").processedCount, 1);
});

test("markBulkEditItemDeferred transitions status to DEFERRED, persists nextAttemptAt, creates enqueue intent, and omits parent processedCount increment", async () => {
  const { snapshotItems, enqueueIntents, editHistories, dbClient } = createFakeBulkApplyDb();

  snapshotItems.set("item-3", {
    id: "item-3",
    shop: "store.myshopify.com",
    operationId: "job-123",
    executionStatus: "SUBMITTED",
    executionOwnerId: "job:1001",
    externalAttemptId: "attempt-aaa",
  });

  editHistories.set("job-123", {
    id: "job-123",
    shop: "store.myshopify.com",
    processedCount: 0,
  });

  const okDeferred = await markBulkEditItemDeferred({
    bulkApplyJobId: "job-123",
    itemId: "item-3",
    shop: "store.myshopify.com",
    executionOwnerId: "job:1001",
    externalAttemptId: "attempt-aaa",
    retryAfterMs: 300000,
    nextAttemptNumber: 2,
    dbClient,
  });

  assert.equal(okDeferred, true);

  const itemState = snapshotItems.get("item-3");
  assert.equal(itemState.executionStatus, "DEFERRED");
  assert.equal(itemState.executionOwnerId, null);
  assert.equal(itemState.shopifyErrorCode, "LONG_RETRY_AFTER");
  assert.ok(itemState.nextAttemptAt instanceof Date);

  // Parent processedCount must NOT be incremented for deferred items
  assert.equal(editHistories.get("job-123").processedCount, 0);

  // Enqueue intent created
  assert.equal(enqueueIntents.length, 1);
  const intent = enqueueIntents[0];
  assert.equal(intent.shop, "store.myshopify.com");
  assert.equal(intent.queueRoutingKey, "BULK_EDIT_ITEM_APPLY");
  assert.equal(intent.queueJobName, "apply-metafield-item");
  assert.deepEqual(intent.payload, { shop: "store.myshopify.com", bulkApplyJobId: "job-123", itemId: "item-3" });
  assert.equal(intent.options.delay, 300000);
});
