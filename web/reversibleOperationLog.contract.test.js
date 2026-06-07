import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const preparation = fs.readFileSync(
  path.resolve("web/services/bulkEdit/BulkEditExecutionPreparationService.js"),
  "utf8",
);
const executeWorker = fs.readFileSync(
  path.resolve("web/Jobs/Workers/bulkEditExecuteWorker.js"),
  "utf8",
);
const mutationService = fs.readFileSync(
  path.resolve("web/services/bulkEdit/ShopifyBulkMutationService.js"),
  "utf8",
);

test("bulk execution persists and verifies reversible records during preparation", () => {
  assert.match(preparation, /function buildReversibleChangeRecord/);
  assert.match(preparation, /REVERSIBLE_LOG_BEFORE_VALUES_REQUIRED/);
  assert.match(preparation, /REVERSIBLE_LOG_AFTER_VALUES_REQUIRED/);
  assert.match(preparation, /await db\.changeRecord\.createMany\(\{/);
  assert.match(preparation, /REVERSIBLE_OPERATION_LOG_INCOMPLETE/);
  assert.match(preparation, /reversibleOperationLog: true/);
});

test("reversible operation log is completed before Shopify submission", () => {
  const prepareIndex = executeWorker.indexOf(
    "await preparationService.prepareNextExecutionBatch",
  );
  const submitIndex = executeWorker.indexOf(
    "await mutationService.submitProductSetBulkMutation",
  );
  assert.ok(prepareIndex > -1);
  assert.ok(submitIndex > prepareIndex);
});

test("both frozen and CSV execution paths materialize reversible records", () => {
  const calls = preparation.match(/await persistAndVerifyReversibleOperationLog\(\{/g) || [];
  assert.ok(calls.length >= 2);
  assert.match(preparation, /beforeValues: row\.beforeValues/);
  assert.match(preparation, /afterValues: row\.plannedMutation/);
});

test("Shopify submission itself fails closed without a complete reversible log", () => {
  const guardIndex = mutationService.indexOf("await assertReversibleOperationLog({");
  const mutationIndex = mutationService.indexOf("const bulkRes = await this.client.query");
  assert.ok(guardIndex > -1);
  assert.ok(mutationIndex > guardIndex);
  assert.match(mutationService, /SHOPIFY_WRITE_BLOCKED_REVERSIBLE_LOG_INCOMPLETE/);
  assert.match(mutationService, /SHOPIFY_WRITE_BLOCKED_OPERATION_NOT_REVERSIBLE/);
});
