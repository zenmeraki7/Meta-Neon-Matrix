import test from "node:test";
import assert from "node:assert/strict";
import {
  SHOPIFY_BULK_MUTATION_SLOT,
  acquireShopifyBulkMutationSlot,
} from "./services/shopifyBulkMutationSlotLease.js";

test("simultaneous same-shop bulk submissions share one mutation slot", async () => {
  let held = false;
  const calls = [];
  const acquireLease = async (input) => {
    calls.push(input);
    if (held) return { acquired: false };
    held = true;
    return { acquired: true };
  };

  const [first, second] = await Promise.all([
    acquireShopifyBulkMutationSlot({
      shop: "slot.myshopify.com",
      ownerId: "edit-owner",
      acquireLease,
    }),
    acquireShopifyBulkMutationSlot({
      shop: "slot.myshopify.com",
      ownerId: "undo-owner",
      acquireLease,
    }),
  ]);

  assert.equal(first.acquired, true);
  assert.equal(second.acquired, false);
  assert.equal(calls[0].namespace, SHOPIFY_BULK_MUTATION_SLOT);
  assert.equal(calls[0].resourceId, "slot.myshopify.com");
  assert.equal(calls[1].resourceId, calls[0].resourceId);
});
