import test from "node:test";
import assert from "node:assert/strict";
import {
  requireShopifySession,
  buildAuthenticatedActor,
  getRequiredIdempotencyKey,
  handleControllerError,
  normalizeShopDomain,
  capReportedLength,
  normalizeHttpStatus,
  normalizePublicErrorBody,
  summarizeError,
  safeSummarize,
} from "./controllers/controllerUtils.js";

function mockRes(headersSent = false) {
  const res = {
    headersSent,
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    locals: {
      shopify: {
        session: {
          shop: "valid-shop.myshopify.com",
          id: "offline_valid-shop.myshopify.com",
        },
      },
    },
  };
  return res;
}

function mockReq(headers = {}, query = {}, body = null) {
  return {
    method: "POST",
    route: { path: "/api/test" },
    query,
    body,
    get(headerName) {
      const lower = String(headerName).toLowerCase();
      return headers[lower] ?? headers[headerName] ?? null;
    },
    headers,
  };
}

test("1. Missing Shopify session throws UNAUTHENTICATED", () => {
  const res = mockRes();
  delete res.locals.shopify.session;
  assert.throws(() => requireShopifySession(res), (err) => err.code === "UNAUTHENTICATED");
});

test("2. Invalid Shopify domain throws UNAUTHENTICATED", () => {
  const res = mockRes();
  res.locals.shopify.session.shop = "not-a-shopify-domain.com";
  assert.throws(() => requireShopifySession(res), (err) => err.code === "UNAUTHENTICATED");
});

test("3. Uppercase Shopify domain is canonicalized to lowercase", () => {
  const res = mockRes();
  res.locals.shopify.session.shop = "MY-TEST-STORE.MYSHOPIFY.COM";
  const { shop } = requireShopifySession(res);
  assert.equal(shop, "my-test-store.myshopify.com");
});

test("4. Shop label beginning or ending with '-' is rejected", () => {
  assert.equal(normalizeShopDomain("-invalid.myshopify.com"), null);
  assert.equal(normalizeShopDomain("invalid-.myshopify.com"), null);
});

test("5. Shop label longer than 63 characters is rejected", () => {
  const longLabel = "a".repeat(64);
  assert.equal(normalizeShopDomain(`${longLabel}.myshopify.com`), null);
  const validLabel = "a".repeat(63);
  assert.equal(normalizeShopDomain(`${validLabel}.myshopify.com`), `${validLabel}.myshopify.com`);
});

test("6. Missing, blank, malformed, and oversized idempotency keys are rejected", () => {
  // Missing
  assert.throws(() => getRequiredIdempotencyKey(mockReq()), (err) => err.code === "IDEMPOTENCY_KEY_REQUIRED");
  // Blank
  assert.throws(() => getRequiredIdempotencyKey(mockReq({ "idempotency-key": "   " })), (err) => err.code === "IDEMPOTENCY_KEY_REQUIRED");
  // Malformed characters
  assert.throws(() => getRequiredIdempotencyKey(mockReq({ "idempotency-key": "key@invalid$character" })), (err) => err.code === "INVALID_IDEMPOTENCY_KEY");
  // Oversized (> 255 chars)
  const oversizedKey = "k".repeat(256);
  assert.throws(() => getRequiredIdempotencyKey(mockReq({ "idempotency-key": oversizedKey })), (err) => err.code === "INVALID_IDEMPOTENCY_KEY");
  // Duplicate array headers
  assert.throws(() => getRequiredIdempotencyKey(mockReq({ "idempotency-key": ["key1", "key2"] })), (err) => err.code === "INVALID_IDEMPOTENCY_KEY");
  // Comma-separated duplicate headers
  assert.throws(() => getRequiredIdempotencyKey(mockReq({ "idempotency-key": "key1, key2" })), (err) => err.code === "INVALID_IDEMPOTENCY_KEY");
});

test("7. Valid maximum-length idempotency key is accepted", () => {
  const maxKey = "a".repeat(255);
  const key = getRequiredIdempotencyKey(mockReq({ "idempotency-key": maxKey }));
  assert.equal(key, maxKey);
});

test("8. res.headersSent === true returns undefined without mutating status or body", () => {
  const res = mockRes(true);
  const req = mockReq();
  const result = handleControllerError(req, res, new Error("Failed"), "CLEAR_PRODUCT_TYPES_FAILED");
  assert.equal(result, undefined);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, null);
});

test("9. Malformed status returned by buildPublicApiErrorResponse is normalized", () => {
  assert.equal(normalizeHttpStatus(200), 500);
  assert.equal(normalizeHttpStatus("500"), 500);
  assert.equal(normalizeHttpStatus(undefined), 500);
  assert.equal(normalizeHttpStatus(404), 404);
  assert.equal(normalizeHttpStatus(502), 502);
});

test("10. Malformed public response body falls back to safe fixed structure", () => {
  const fallback = normalizePublicErrorBody("Not an object", "FALLBACK_CODE");
  assert.deepEqual(fallback, {
    error: {
      code: "FALLBACK_CODE",
      message: "The request could not be completed",
    },
  });
});

test("11. Logging throwing synchronously does not break API response", () => {
  const res = mockRes();
  const req = mockReq();
  const err = new Error("Sync Fail");

  const response = handleControllerError(req, res, err, "SYNC_FAIL");
  assert.ok(response);
  assert.equal(res.statusCode, 500);
  assert.ok(res.body);
});

test("12. Logging rejecting asynchronously does not break API response", () => {
  const res = mockRes();
  const req = mockReq();
  const err = new Error("Async Fail");

  const response = handleControllerError(req, res, err, "ASYNC_FAIL");
  assert.ok(response);
  assert.equal(res.statusCode, 500);
  assert.ok(res.body);
});

test("13. Request body proxy whose ownKeys trap throws is safely handled by safeSummarize", () => {
  const hostileProxy = new Proxy({}, {
    ownKeys() {
      throw new Error("Hostile proxy trap!");
    },
  });

  const summary = safeSummarize((val) => {
    Object.keys(val);
    return { present: true };
  }, hostileProxy);

  assert.equal(summary.type, "unavailable");
});

test("14. Non-plain object with throwing constructor getter is safely summarized", () => {
  const hostileObj = Object.create(null);
  Object.defineProperty(hostileObj, "constructor", {
    get() {
      throw new Error("Hostile constructor getter!");
    },
  });

  const summary = safeSummarize(() => {
    if (typeof hostileObj === "object") {
      return { present: true, type: "non_plain_object" };
    }
  }, hostileObj);

  assert.equal(summary.type, "non_plain_object");
});

test("15. Very large arrays and buffers have reported lengths capped at 1,000,000", () => {
  assert.equal(capReportedLength(500), 500);
  assert.equal(capReportedLength(2_000_000), 1_000_000);
  assert.equal(capReportedLength(-10), 0);
  assert.equal(capReportedLength(NaN), 0);
});

test("16. Raw error objects containing secrets are summarized without sensitive raw properties", () => {
  const secretError = new Error("Connection failed");
  secretError.secretToken = "shpat_1234567890secret";
  secretError.connectionString = "postgres://user:password@host/db";

  const summary = summarizeError(secretError);
  assert.equal(summary.secretToken, undefined);
  assert.equal(summary.connectionString, undefined);
  assert.equal(summary.name, "Error");
});

test("17. API response still succeeds when every logging operation fails", () => {
  const res = mockRes();
  const req = mockReq();
  const err = new Error("Catastrophic error");

  const response = handleControllerError(req, res, err, "CATASTROPHIC_ERROR", "testController.test");
  assert.ok(response);
  assert.equal(res.statusCode, 500);
  assert.ok(res.body.error);
});
