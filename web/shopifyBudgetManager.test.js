import test from "node:test";
import assert from "node:assert/strict";
import {
  ShopifyBudgetManager,
  clearBudgetManagersForTests,
  getBudgetManager,
  isThrottleError,
} from "./services/shopify/ShopifyBudgetManager.js";

function costExtensions(currentlyAvailable, restoreRate = 50) {
  return {
    cost: {
      throttleStatus: {
        currentlyAvailable,
        restoreRate,
        maximumAvailable: 1000,
      },
    },
  };
}

test("budget manager waits until projected points include 50 percent headroom", async () => {
  let nowMs = 0;
  const waits = [];
  const manager = new ShopifyBudgetManager("budget.myshopify.com", {
    nowFn: () => nowMs,
    sleepFn: async (ms) => {
      waits.push(ms);
      nowMs += ms;
    },
  });
  manager.updateFromResponse(costExtensions(25, 50));

  const waitMs = await manager.waitForBudget(50);

  assert.equal(waitMs, 1000);
  assert.deepEqual(waits, [1000]);
});

test("response cost updates shared state before the next call", async () => {
  let nowMs = 0;
  const waits = [];
  const manager = new ShopifyBudgetManager("shared.myshopify.com", {
    nowFn: () => nowMs,
    sleepFn: async (ms) => {
      waits.push(ms);
      nowMs += ms;
    },
  });

  await manager.executeWithBudget(50, async () => ({
    body: {
      data: { ok: true },
      extensions: costExtensions(25, 50),
    },
  }));
  await manager.executeWithBudget(50, async () => ({
    body: {
      data: { ok: true },
      extensions: costExtensions(900, 50),
    },
  }));

  assert.deepEqual(waits, [1000]);
  assert.equal(manager.currentlyAvailable, 900);
});

test("budget managers are singleton per shop", () => {
  clearBudgetManagersForTests();
  const first = getBudgetManager("singleton.myshopify.com");
  const second = getBudgetManager("singleton.myshopify.com");
  const other = getBudgetManager("other.myshopify.com");

  assert.equal(first, second);
  assert.notEqual(first, other);
});

test("throttle detection covers HTTP and GraphQL Shopify errors", () => {
  assert.equal(isThrottleError({ response: { status: 429 } }), true);
  assert.equal(isThrottleError({
    body: { errors: [{ extensions: { code: "THROTTLED" } }] },
  }), true);
  assert.equal(isThrottleError({ message: "Shopify request was Throttled" }), true);
  assert.equal(isThrottleError({ response: { status: 422 } }), false);
});

test("executeWithBudget surfaces returned GraphQL throttle errors", async () => {
  const manager = new ShopifyBudgetManager("throttled.myshopify.com");

  await assert.rejects(
    manager.executeWithBudget(50, async () => ({
      body: {
        errors: [{
          message: "Throttled",
          extensions: { code: "THROTTLED" },
        }],
        extensions: costExtensions(10, 50),
      },
    })),
    (error) => isThrottleError(error),
  );
  assert.equal(manager.currentlyAvailable, 10);
});
