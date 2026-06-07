import test from "node:test";
import assert from "node:assert/strict";
import {
  CircuitOpenError,
  clearShopifyCircuitsForTests,
  executeWithShopifyCircuit,
  isShopifyInfrastructureError,
} from "./services/shopify/ShopifyCircuitBreaker.js";

test("Shopify infrastructure failures open a per-shop circuit", async () => {
  clearShopifyCircuitsForTests();
  let calls = 0;
  const nowMs = new Date("2026-06-07T12:00:00.000Z").getTime();

  await assert.rejects(
    executeWithShopifyCircuit(
      "down.myshopify.com",
      async () => {
        calls += 1;
        const error = new Error("Service unavailable");
        error.response = { status: 503, headers: { "retry-after": "120" } };
        throw error;
      },
      { nowFn: () => nowMs },
    ),
    (error) =>
      error instanceof CircuitOpenError
      && error.retryAfter.getTime() === nowMs + 120_000,
  );

  await assert.rejects(
    executeWithShopifyCircuit(
      "down.myshopify.com",
      async () => {
        calls += 1;
      },
      { nowFn: () => nowMs + 1_000 },
    ),
    (error) => error instanceof CircuitOpenError,
  );
  assert.equal(calls, 1);
});

test("throttling and auth failures do not open the infrastructure circuit", () => {
  assert.equal(isShopifyInfrastructureError({ response: { status: 429 } }), false);
  assert.equal(isShopifyInfrastructureError({ response: { status: 401 } }), false);
  assert.equal(isShopifyInfrastructureError({ message: "ECONNRESET" }), true);
});
