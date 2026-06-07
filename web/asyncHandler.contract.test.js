import test from "node:test";
import assert from "node:assert/strict";
import { asyncHandler, errorTypeForStatus } from "./utils/asyncHandler.js";

function createResponseCapture() {
  return {
    locals: {},
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("asyncHandler maps status codes to honest error types", () => {
  assert.equal(errorTypeForStatus(400), "VALIDATION");
  assert.equal(errorTypeForStatus(401), "AUTH");
  assert.equal(errorTypeForStatus(403), "PERMISSION");
  assert.equal(errorTypeForStatus(429), "RATE_LIMIT");
  assert.equal(errorTypeForStatus(503), "UNAVAILABLE");
  assert.equal(errorTypeForStatus(500), "SERVER_ERROR");
  assert.equal(errorTypeForStatus(418), "UNKNOWN");
});

test("asyncHandler surfaces explicit retryability and preserves explicit type", async () => {
  const res = createResponseCapture();
  const error = new Error("queue unavailable");
  error.statusCode = 503;
  error.type = "QUEUE";
  error.retryable = true;

  await asyncHandler(async () => {
    throw error;
  })(
    { originalUrl: "/test", method: "POST" },
    res,
    () => {},
  );

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.type, "QUEUE");
  assert.equal(res.body.retryable, true);
});

test("asyncHandler does not invent retryability", async () => {
  const res = createResponseCapture();
  const error = new Error("failed");
  error.statusCode = 500;

  await asyncHandler(async () => {
    throw error;
  })(
    { originalUrl: "/test", method: "GET" },
    res,
    () => {},
  );

  assert.equal(res.body.type, "SERVER_ERROR");
  assert.equal(Object.hasOwn(res.body, "retryable"), false);
});
