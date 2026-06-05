import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MutationPlanner,
  planMutationExecution,
} from "./services/bulkEdit/planner/mutationPlanner.js";

const plannerSource = readFileSync(
  new URL("./services/bulkEdit/planner/mutationPlanner.js", import.meta.url),
  "utf8",
);
const registrySource = readFileSync(
  new URL("./services/bulkEdit/planner/productEditOperationRegistry.js", import.meta.url),
  "utf8",
);

test("mutation planner has no duplicate supportsUndo return key", () => {
  const returnObject = plannerSource.slice(plannerSource.indexOf("return {", plannerSource.indexOf("planMutationExecution")));
  const matches = returnObject.match(/\bsupportsUndo\b/g) || [];
  assert.equal(matches.length, 1);
});

test("mutation planner does not fallback to PRODUCT_GENERIC_SET for missing definitions", () => {
  assert.doesNotMatch(plannerSource, /\|\|\s*ProductEditOperationRegistry\.PRODUCT_EDIT_OPERATIONS\.PRODUCT_GENERIC_SET/);
});

test("mutation planner uses explicit registry executionPath rather than mutation-name parsing", () => {
  assert.match(registrySource, /executionPath:/);
  assert.doesNotMatch(plannerSource, /graphqlMutationName\.startsWith/);
});

test("mutation planner validates plan type and operation key", () => {
  assert.throws(
    () => planMutationExecution({
      operationKey: "TITLE_SET",
      operationId: "op-0",
      targetCount: 1,
    }),
    /shop is required/,
  );

  assert.throws(
    () => planMutationExecution({
      operationKey: "TITLE_SET",
      operationId: "op-1",
      shop: "s1.myshopify.com",
      planType: "TYPO",
      targetCount: 1,
    }),
    /UNKNOWN_PLAN_TYPE:TYPO/,
  );

  assert.throws(
    () => planMutationExecution({
      operationKey: "DOES_NOT_EXIST",
      operationId: "op-2",
      shop: "s1.myshopify.com",
      targetCount: 1,
    }),
    /UNKNOWN_OPERATION_KEY:DOES_NOT_EXIST/,
  );
});

test("mutation planner does not generate operation ids", () => {
  const plan = planMutationExecution({
    operationKey: "TITLE_SET",
    shop: "s1.myshopify.com",
    targetCount: 1,
  });

  assert.equal(plan.operationId, null);
});

test("mutation planner applies plan max batch size and exposes cost unit", () => {
  const plan = planMutationExecution({
    operationKey: "TITLE_SET",
    operationId: "op-3",
    shop: "s1.myshopify.com",
    targetCount: 10_000,
    shopPlanLimits: {
      maxBatchSize: 500,
      byShop: {
        "s1.myshopify.com": { maxBatchSize: 100 },
      },
    },
  });

  assert.equal(plan.batchSize, 100);
  assert.equal(plan.estimatedCostUnit, "planner_weight_units");
  assert.equal(typeof plan.costUnit, "number");
});

test("mutation planner routes chunked operations by registry executionPath", () => {
  const inventoryPlan = planMutationExecution({
    operationKey: "INVENTORY_SET",
    operationId: "op-4",
    shop: "s1.myshopify.com",
    targetCount: 100,
  });
  assert.equal(
    inventoryPlan.executionPath,
    MutationPlanner.EXECUTION_PATHS.INVENTORY_MUTATIONS,
  );

  const mediaPlan = planMutationExecution({
    operationKey: "MEDIA_SET",
    operationId: "op-5",
    shop: "s1.myshopify.com",
    targetCount: 100,
  });
  assert.equal(
    mediaPlan.executionPath,
    MutationPlanner.EXECUTION_PATHS.MEDIA_MUTATIONS,
  );
});
