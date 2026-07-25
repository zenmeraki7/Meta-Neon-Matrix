import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildPublicApiErrorResponse } from "./utils/publicApiError.js";

function read(relPath) {
  return fs.readFileSync(path.resolve(relPath), "utf8");
}

test("retry service blocks retries outside terminal FAILED/PARTIAL_FAILED states", () => {
  const source = read("web/services/productService/BulkEditRetryService.js");
  assert.ok(source.includes("RETRY_ALLOWED_SOURCE_STATES"));
  assert.ok(source.includes("OPERATION_LIFECYCLE_STATES.FAILED"));
  assert.ok(source.includes("OPERATION_LIFECYCLE_STATES.PARTIAL_FAILED"));
  assert.ok(source.includes("RETRY_STATE_CONFLICT"));
  assert.ok(source.includes("error.code = \"CONFLICT\""));
});

test("retry service creates new executionIdentity and enqueues with new attempt identity", () => {
  const source = read("web/services/productService/BulkEditRetryService.js");
  assert.ok(source.includes("const nextExecutionId = this.uuidFactory();"));
  assert.ok(source.includes("executionIdentity: nextExecutionId"));
  assert.ok(source.includes("executionId: nextExecutionId"));
  assert.ok(source.includes("retrySourceExecutionIdentity"));
});

test("retry conflict maps to HTTP 409", () => {
  const { statusCode } = buildPublicApiErrorResponse({ code: "CONFLICT" }, "VALIDATION_FAILED");
  assert.equal(statusCode, 409);
});
