import test from "node:test";
import assert from "node:assert/strict";
import {
  suspendBulkEditForShopifyOutage,
  suspendBulkUndoForShopifyOutage,
  suspensionDelayMs,
} from "./services/bulkEdit/bulkOperationSuspensionService.js";
import { CircuitOpenError } from "./services/shopify/ShopifyCircuitBreaker.js";

function fakeClient(record) {
  return {
    editHistory: {
      findFirst: async () => record,
      updateMany: async (args) => {
        record.update = args;
        return { count: 1 };
      },
    },
  };
}

test("bulk edit outage suspension returns operation to pending without failure", async () => {
  const record = { batch: { existing: true } };
  const retryAfter = new Date(Date.now() + 60_000);
  const error = new CircuitOpenError("shop.myshopify.com", retryAfter);

  await suspendBulkEditForShopifyOutage({
    historyId: "history-1",
    shop: "shop.myshopify.com",
    error,
    client: fakeClient(record),
  });

  assert.equal(record.update.data.status, "pending");
  assert.equal(record.update.data.executionState, "SUSPENDED");
  assert.equal(record.update.data.batch.suspension.suspendReason, "SHOPIFY_UNAVAILABLE");
  assert.equal(record.update.data.batch.suspension.resumeAfter, retryAfter.toISOString());
});

test("bulk undo outage suspension preserves undo state and records resume time", async () => {
  const record = { undo: { executionIdentity: "undo-execution-1" } };
  const retryAfter = new Date(Date.now() + 60_000);

  await suspendBulkUndoForShopifyOutage({
    historyId: "history-1",
    shop: "shop.myshopify.com",
    error: new CircuitOpenError("shop.myshopify.com", retryAfter),
    client: fakeClient(record),
  });

  assert.equal(record.update.data.status, "pending");
  assert.equal(record.update.data.undo.state, "suspended");
  assert.equal(record.update.data.undo.executionIdentity, "undo-execution-1");
  assert.equal(record.update.data.undo.resumeAfter, retryAfter.toISOString());
});

test("suspension delay respects retryAfter and has a one-second floor", () => {
  const nowMs = Date.now();
  assert.equal(
    suspensionDelayMs(
      new CircuitOpenError("shop.myshopify.com", new Date(nowMs + 30_000)),
      nowMs,
    ),
    30_000,
  );
  assert.equal(
    suspensionDelayMs(
      new CircuitOpenError("shop.myshopify.com", new Date(nowMs - 1)),
      nowMs,
    ),
    1_000,
  );
});
