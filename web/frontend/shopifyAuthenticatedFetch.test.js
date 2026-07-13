import assert from "node:assert/strict";
import test from "node:test";
import {
  createShopifyAuthenticatedFetch,
  getFreshShopifySessionToken,
} from "./api/shopifyAuthenticatedFetch.js";

test("valid App Bridge session token is attached freshly", async () => {
  let receivedAuthorization = null;
  const authFetch = createShopifyAuthenticatedFetch({
    getSessionToken: async () => "fresh-token",
    fetchImpl: async (_url, options) => {
      receivedAuthorization = options.headers.get("Authorization");
      return new Response(JSON.stringify({ status: "QUEUED" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const response = await authFetch("/api/history/history123/undo", {
    method: "POST",
    headers: { Authorization: "Bearer stale-token" },
  });

  assert.equal(response.status, 202);
  assert.equal(receivedAuthorization, "Bearer fresh-token");
});

test("missing App Bridge context fails closed", async () => {
  await assert.rejects(
    getFreshShopifySessionToken(null),
    (error) => error.code === "APP_BRIDGE_CONTEXT_MISSING"
  );
});

test("token acquisition failure is classified accurately", async () => {
  await assert.rejects(
    getFreshShopifySessionToken({
      idToken: async () => {
        throw new Error("bridge rejected token request");
      },
    }),
    (error) => error.code === "SESSION_TOKEN_ACQUISITION_FAILED"
  );
});

test("401 response acquires one new token and retries at most once", async () => {
  const tokens = [];
  let requestCount = 0;
  const authFetch = createShopifyAuthenticatedFetch({
    getSessionToken: async () => {
      const token = `token-${tokens.length + 1}`;
      tokens.push(token);
      return token;
    },
    fetchImpl: async (_url, options) => {
      requestCount += 1;
      assert.equal(
        options.headers.get("Authorization"),
        `Bearer token-${requestCount}`
      );
      return new Response(null, { status: 401 });
    },
  });

  const response = await authFetch("/api/history/history123/undo", {
    method: "POST",
  });

  assert.equal(response.status, 401);
  assert.equal(requestCount, 2);
  assert.deepEqual(tokens, ["token-1", "token-2"]);
});

test("non-401 undo rejection is not retried", async () => {
  let requestCount = 0;
  const authFetch = createShopifyAuthenticatedFetch({
    getSessionToken: async () => "fresh-token",
    fetchImpl: async () => {
      requestCount += 1;
      return new Response(null, { status: 403 });
    },
  });

  const response = await authFetch("/api/history/history123/undo", {
    method: "POST",
  });

  assert.equal(response.status, 403);
  assert.equal(requestCount, 1);
});

test("network failure is classified without unauthenticated fallback", async () => {
  const authFetch = createShopifyAuthenticatedFetch({
    getSessionToken: async () => "fresh-token",
    fetchImpl: async () => {
      throw new TypeError("offline");
    },
  });

  await assert.rejects(
    authFetch("/api/history/history123/undo", { method: "POST" }),
    (error) => error.code === "NETWORK_FAILURE"
  );
});
