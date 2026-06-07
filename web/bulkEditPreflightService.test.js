import test from "node:test";
import assert from "node:assert/strict";
import {
  PreflightError,
  preflightEntitlement,
  preflightMirrorState,
  preflightPreviewContract,
  preflightScope,
  preflightValues,
  runBulkEditPreflight,
} from "./services/bulkEdit/BulkEditPreflightService.js";

const healthyStore = {
  activeMirrorBatchId: "batch-1",
  mirrorHealthState: "HEALTHY",
  repairRequired: false,
  lastFullSyncAt: new Date("2026-06-07T00:00:00.000Z"),
  lastIncrementalSyncAt: new Date("2026-06-07T05:00:00.000Z"),
};

const previewRecord = {
  expiresAt: new Date("2026-06-07T07:00:00.000Z"),
  value: {
    mirrorBatchId: "batch-1",
    filterHash: "filter-1",
  },
};

function hasCode(code) {
  return (error) => error instanceof PreflightError && error.code === code;
}

test("broad and critical targets require explicit confirmations", () => {
  assert.throws(
    () => preflightScope({ targetCount: 1001 }),
    hasCode("BROAD_TARGET_REQUIRES_CONFIRMATION"),
  );
  assert.throws(
    () => preflightScope({
      targetCount: 10001,
      confirmBroadTarget: true,
      criticalConfirmationText: "CONFIRM",
    }),
    hasCode("CRITICAL_TARGET_REQUIRES_TEXT_CONFIRMATION"),
  );
  assert.equal(
    preflightScope({
      targetCount: 10001,
      confirmBroadTarget: true,
      criticalConfirmationText: "EDIT 10,001 PRODUCTS",
    }).targetCount,
    10001,
  );
});

test("hazardous values are blocked or require confirmation", () => {
  assert.throws(
    () => preflightValues({
      rules: [{ field: "price", editOption: "Set to fixed value", value: 0 }],
    }),
    hasCode("ZERO_PRICE_REQUIRES_CONFIRMATION"),
  );
  assert.throws(
    () => preflightValues({
      rules: [{ field: "compareAtPrice", editOption: "Set to fixed value", value: -1 }],
      confirmBroadTarget: true,
    }),
    hasCode("NEGATIVE_PRICE_NOT_ALLOWED"),
  );
  assert.throws(
    () => preflightValues({
      rules: [{ field: "inventory", editOption: "Set to fixed value", value: -1 }],
      confirmBroadTarget: true,
    }),
    hasCode("NEGATIVE_INVENTORY_NOT_ALLOWED"),
  );
});

test("preview contract rejects expiry, batch changes, and fingerprint changes", () => {
  assert.throws(
    () => preflightPreviewContract({
      previewRecord,
      activeMirrorBatchId: "batch-1",
      now: new Date("2026-06-07T08:00:00.000Z"),
    }),
    hasCode("PREVIEW_EXPIRED"),
  );
  assert.throws(
    () => preflightPreviewContract({
      previewRecord,
      activeMirrorBatchId: "batch-2",
      now: new Date("2026-06-07T06:00:00.000Z"),
    }),
    hasCode("PREVIEW_MIRROR_BATCH_STALE"),
  );
  assert.throws(
    () => preflightPreviewContract({
      previewRecord,
      activeMirrorBatchId: "batch-1",
      command: { previewFilterHash: "changed" },
      now: new Date("2026-06-07T06:00:00.000Z"),
    }),
    hasCode("PREVIEW_TARGETING_FINGERPRINT_MISMATCH"),
  );
});

test("mirror and entitlement checks fail closed", () => {
  assert.throws(
    () => preflightMirrorState({
      ...healthyStore,
      mirrorHealthState: "UNSAFE",
      repairRequired: true,
    }),
    hasCode("MIRROR_UNSAFE"),
  );
  assert.equal(
    preflightMirrorState(
      healthyStore,
      new Date("2026-06-07T12:00:01.000Z").getTime(),
    ).stale,
    true,
  );
  assert.throws(
    () => preflightEntitlement({
      targetCount: 1001,
      subscription: { planKey: "FREE" },
    }),
    hasCode("PLAN_LIMIT_EXCEEDED"),
  );
});

test("runner returns warnings and a durable successful result", () => {
  const result = runBulkEditPreflight({
    command: {
      previewId: "preview-1",
      previewFilterHash: "filter-1",
      previewMirrorBatchId: "batch-1",
      confirmBroadTarget: true,
    },
    previewRecord,
    store: healthyStore,
    rules: [{ field: "title", editOption: "Set value", value: "Updated" }],
    targetCount: 1500,
    subscription: { planKey: "BASIC_MONTHLY" },
    now: new Date("2026-06-07T06:00:00.000Z"),
  });

  assert.equal(result.passed, true);
  assert.equal(result.targetCount, 1500);
  assert.equal(result.warnings.some((warning) => warning.code === "BROAD_TARGET"), true);
});
