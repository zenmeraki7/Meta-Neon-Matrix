import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOperationTimeline,
  getLifecycleStageKeys,
} from "./Domain/products/edit/utils/operationTimeline.js";

test("lifecycle timeline contains required states in canonical order", () => {
  const stages = getLifecycleStageKeys();
  const required = [
    "PLANNED",
    "WAITING_FOR_SHOPIFY_SLOT",
    "VERIFYING",
    "MIRROR_UPDATING",
  ];

  for (const key of required) {
    assert.equal(stages.includes(key), true, `Missing required lifecycle state: ${key}`);
  }

  const waitingIndex = stages.indexOf("WAITING_FOR_SHOPIFY_SLOT");
  const verifyingIndex = stages.indexOf("VERIFYING");
  const mirrorUpdatingIndex = stages.indexOf("MIRROR_UPDATING");
  assert.equal(stages.indexOf("PLANNED") < stages.indexOf("TARGET_FREEZING"), true, "PLANNED should appear before target freezing");
  assert.equal(waitingIndex < verifyingIndex, true, "WAITING_FOR_SHOPIFY_SLOT should appear before VERIFYING");
  assert.equal(verifyingIndex < mirrorUpdatingIndex, true, "VERIFYING should appear before MIRROR_UPDATING");
});

test("simulated lifecycle progression marks states in-order", () => {
  const sequence = [
    "PLANNED",
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

test("planned operation does not mark target freeze stages completed", () => {
  const timeline = buildOperationTimeline("PLANNED");

  assert.equal(timeline.currentState, "PLANNED");
  assert.equal(timeline.stages.find((stage) => stage.key === "PLANNED")?.status, "active");
  assert.equal(timeline.stages.find((stage) => stage.key === "TARGET_FREEZING")?.status, "pending");
  assert.equal(timeline.stages.find((stage) => stage.key === "TARGET_FROZEN")?.status, "pending");
  assert.equal(timeline.stages.find((stage) => stage.key === "QUEUED")?.status, "pending");
});

