import test from "node:test";
import assert from "node:assert/strict";
import { createPublicApiErrorMiddleware } from "./middleware/publicApiErrorMiddleware.js";

function createRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test("public error middleware maps VALIDATION_FAILED to safe 400", async () => {
  const calls = [];
  const middleware = createPublicApiErrorMiddleware({
    logger: { error: (...args) => calls.push(args) },
  });

  const err = new Error("raw validation details should not leak");
  err.code = "VALIDATION_FAILED";

  const req = { path: "/api/collection/get-all", method: "GET", headers: {} };
  const res = createRes();

  middleware(err, req, res, () => {});

  assert.equal(res.statusCode, 400);
  assert.equal(res.body?.success, false);
  assert.equal(res.body?.code, "VALIDATION_FAILED");
  assert.ok(!("stack" in res.body));
  assert.ok(!JSON.stringify(res.body).includes("raw validation details"));
  assert.equal(calls.length, 1);
});

test("public error middleware maps UNAUTHENTICATED to safe 401", async () => {
  const calls = [];
  const middleware = createPublicApiErrorMiddleware({
    logger: { error: (...args) => calls.push(args) },
  });

  const err = new Error("session token xyz");
  err.code = "UNAUTHENTICATED";

  const req = { path: "/api/collection/refresh", method: "POST", headers: {} };
  const res = createRes();

  middleware(err, req, res, () => {});

  assert.equal(res.statusCode, 401);
  assert.equal(res.body?.success, false);
  assert.equal(res.body?.code, "UNAUTHENTICATED");
  assert.ok(!JSON.stringify(res.body).includes("session token xyz"));
  assert.equal(calls.length, 1);
});

test("public error middleware maps unknown errors to safe 500", async () => {
  const calls = [];
  const middleware = createPublicApiErrorMiddleware({
    logger: { error: (...args) => calls.push(args) },
  });

  const err = new Error("database timeout internals");

  const req = {
    path: "/api/collection/live",
    method: "GET",
    headers: { "x-request-id": "req-1" },
  };
  const res = createRes();

  middleware(err, req, res, () => {});

  assert.equal(res.statusCode, 500);
  assert.equal(res.body?.success, false);
  assert.equal(res.body?.code, "INTERNAL_ERROR");
  assert.ok(!("stack" in res.body));
  assert.ok(!JSON.stringify(res.body).includes("database timeout internals"));
  assert.equal(calls.length, 1);
});
