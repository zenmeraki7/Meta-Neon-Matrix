import test from "node:test";
import assert from "node:assert/strict";
import { createPublicApiErrorMiddleware } from "./middleware/publicApiErrorMiddleware.js";
import { buildPublicApiErrorResponse } from "./utils/publicApiError.js";

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

test("public error builder maps statusCode-only validation errors and preserves fields", () => {
  const err = new Error("raw validation details should not leak");
  err.statusCode = 400;
  err.fields = [{ field: "variantCount", error: "must be > 0" }];

  const { statusCode, body } = buildPublicApiErrorResponse(err, "INTERNAL_ERROR");

  assert.equal(statusCode, 400);
  assert.equal(body.success, false);
  assert.equal(body.code, "VALIDATION_FAILED");
  assert.deepEqual(body.fields, err.fields);
  assert.ok(!JSON.stringify(body).includes("raw validation details"));
});

test("public error builder maps session domain errors by specific code", () => {
  const notFound = new Error("raw not found details");
  notFound.code = "SESSION_NOT_FOUND";

  const conflict = new Error("raw conflict details");
  conflict.code = "SESSION_NOT_OPEN";

  assert.equal(buildPublicApiErrorResponse(notFound).statusCode, 404);
  assert.equal(buildPublicApiErrorResponse(notFound).body.code, "NOT_FOUND");
  assert.equal(buildPublicApiErrorResponse(conflict).statusCode, 409);
  assert.equal(buildPublicApiErrorResponse(conflict).body.code, "CONFLICT");
});

test("public error builder maps plan upgrade requirements to forbidden", () => {
  const err = new Error("raw plan internals");
  err.code = "SCHEDULED_EXPORT_PLAN_UPGRADE_REQUIRED";
  err.statusCode = 403;

  const { statusCode, body } = buildPublicApiErrorResponse(err);

  assert.equal(statusCode, 403);
  assert.equal(body.code, "FORBIDDEN");
  assert.ok(!JSON.stringify(body).includes("raw plan internals"));
});

test("public error builder maps recurring edit not-found errors", () => {
  const err = new Error("raw recurring edit details");
  err.code = "RECURRING_EDIT_NOT_FOUND";
  err.statusCode = 404;

  const { statusCode, body } = buildPublicApiErrorResponse(err);

  assert.equal(statusCode, 404);
  assert.equal(body.code, "NOT_FOUND");
  assert.ok(!JSON.stringify(body).includes("raw recurring edit details"));
});
