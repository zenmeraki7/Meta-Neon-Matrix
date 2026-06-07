import assert from "node:assert/strict";
import test from "node:test";
import {
  DEGRADATION_MESSAGES,
  buildDegradationContract,
  degradationFromError,
  degradationFromHistory,
} from "./services/degradationContractService.js";
import { buildPublicApiErrorResponse } from "./utils/publicApiError.js";
import { projectEditHistoryStatus } from "./services/historyStatusProjectionService.js";
import { toEditHistorySummaryResponseDto } from "./dtos/historyDto.js";

test("every degradation message promises automatic recovery without merchant action", () => {
  for (const message of Object.values(DEGRADATION_MESSAGES)) {
    assert.match(message.body, /No action needed\./);
    assert.ok(message.recoveryWindow);
  }
});

test("Shopify suspension includes the persisted resume time", () => {
  const retryAt = "2026-06-07T13:00:00.000Z";
  const degradation = degradationFromHistory({
    executionState: "SUSPENDED",
    batch: {
      suspension: {
        suspendReason: "SHOPIFY_UNAVAILABLE",
        resumeAfter: retryAt,
      },
    },
  });
  assert.equal(degradation.code, "SHOPIFY_UNAVAILABLE");
  assert.equal(degradation.retryAt, retryAt);
});

test("mirror and rate-limit errors map to merchant-safe degradation contracts", () => {
  assert.equal(
    degradationFromError({ code: "MIRROR_UNSAFE_BULK_EDIT_BLOCKED" }).code,
    "MIRROR_UNSAFE",
  );
  assert.equal(
    degradationFromError({ status: 429 }).code,
    "RATE_LIMIT_SUSPENDED",
  );
});

test("unknown server failures receive the generic suspended-job contract", () => {
  const response = buildPublicApiErrorResponse(
    new Error("dependency failed"),
    "INTERNAL_ERROR",
  );
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.code, "INTERNAL_ERROR");
  assert.equal(response.body.degradation.code, "JOB_SUSPENDED");
  assert.match(response.body.message, /No action needed\./);
});

test("buildDegradationContract falls back safely", () => {
  assert.equal(buildDegradationContract("UNKNOWN").code, "JOB_SUSPENDED");
});

test("suspended history remains suspended through projection and DTO serialization", () => {
  const resumeAfter = "2026-06-07T13:00:00.000Z";
  const projected = projectEditHistoryStatus({
    id: "history-1",
    status: "pending",
    statusNormalized: "QUEUED",
    executionState: "SUSPENDED",
    executionStateNormalized: "QUEUED",
    processedCount: 0,
    totalItems: 25,
    targetSnapshotCount: 25,
    batch: {
      suspension: {
        suspendReason: "SHOPIFY_UNAVAILABLE",
        resumeAfter,
      },
    },
    undo: null,
    error: null,
  });
  const response = toEditHistorySummaryResponseDto(projected);
  assert.equal(response.data.primaryStatus.key, "suspended");
  assert.equal(
    response.data.supportStatus.degradation.code,
    "SHOPIFY_UNAVAILABLE",
  );
  assert.equal(response.data.supportStatus.degradation.retryAt, resumeAfter);
});
