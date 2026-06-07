import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOperationTimeline,
  getLifecycleStageKeys,
} from "./Domain/products/edit/utils/operationTimeline.js";

test("lifecycle timeline contains required states in canonical order", () => {
  const stages = getLifecycleStageKeys();
  const required = [
    "WAITING_FOR_SHOPIFY_SLOT",
    "VERIFYING",
    "MIRROR_UPDATING",
    "ROLLING_BACK",
  ];

  for (const key of required) {
    assert.equal(stages.includes(key), true, `Missing required lifecycle state: ${key}`);
  }

  const waitingIndex = stages.indexOf("WAITING_FOR_SHOPIFY_SLOT");
  const verifyingIndex = stages.indexOf("VERIFYING");
  const mirrorUpdatingIndex = stages.indexOf("MIRROR_UPDATING");
  assert.equal(waitingIndex < verifyingIndex, true, "WAITING_FOR_SHOPIFY_SLOT should appear before VERIFYING");
  assert.equal(verifyingIndex < mirrorUpdatingIndex, true, "VERIFYING should appear before MIRROR_UPDATING");
});

test("simulated lifecycle progression marks states in-order", () => {
  const sequence = [
    "TARGET_FREEZING",
    "TARGET_FROZEN",
    "QUEUED",
    "WAITING_FOR_SHOPIFY_SLOT",
    "EXECUTING",
    "SHOPIFY_RUNNING",
    "SHOPIFY_COMPLETED",
    "INGESTING_RESULTS",
    "VERIFYING",
    "MIRROR_UPDATING",
    "COMPLETED",
  ];

  for (const state of sequence) {
    const timeline = buildOperationTimeline(state);
    const activeIndex = timeline.stages.findIndex((stage) => stage.status === "active");
    const completedIndices = timeline.stages
      .filter((stage) => stage.status === "completed")
      .map((stage) => stage.index);

    if (state !== "COMPLETED") {
      assert.equal(activeIndex >= 0, true, `Expected active stage for ${state}`);
      if (completedIndices.length > 0) {
        assert.equal(
          Math.max(...completedIndices) < activeIndex,
          true,
          `Completed stages must precede active stage for ${state}`,
        );
      }
    }
  }
});
