import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (file) => fs.readFileSync(path.resolve(file), "utf8");

test("bootstrap query service validates shop before repository calls", () => {
  const source = read("web/services/bootstrap/bootstrapQueryService.js");
  const operationShopIndex = source.indexOf("const shop = requireShopScope(command?.shop);");
  const operationRepoIndex = source.indexOf("getOperationSummaryByShop(shop)");
  const planRepoIndex = source.indexOf("getSubscriptionPlanSnapshotByShop(shop)");

  assert.ok(operationShopIndex > -1);
  assert.ok(operationRepoIndex > -1);
  assert.ok(planRepoIndex > -1);
  assert.ok(operationShopIndex < operationRepoIndex);
  assert.ok(operationShopIndex < planRepoIndex);
  assert.equal(source.includes("String(command?.shop || \"\").trim()"), false);
});

test("bootstrap query service uses command-object inputs consistently", () => {
  const source = read("web/services/bootstrap/bootstrapQueryService.js");
  const useCaseSource = read("web/useCases/bootstrapUseCases.js");

  assert.ok(source.includes("export async function getOperationSummary(command = {})"));
  assert.ok(source.includes("export async function getBootstrapPlanSnapshot(command = {})"));
  assert.ok(useCaseSource.includes("getBootstrapPlanSnapshot({ shop })"));
  assert.equal(useCaseSource.includes("getBootstrapPlanSnapshot(shop)"), false);
});

test("bootstrap plan snapshot exposes cached allowlisted plan fields", () => {
  const source = read("web/services/bootstrap/bootstrapQueryService.js");

  assert.ok(source.includes("const PLAN_RESPONSE_FIELDS"));
  assert.ok(source.includes("const CACHED_PLAN_CATALOG = Object.freeze"));
  assert.ok(source.includes("sanitizePlanForBootstrap"));
  assert.ok(source.includes("getPlansArray().map((plan) => sanitizePlanForBootstrap(plan))"));
  assert.equal(source.includes("...plan,"), false);
});

test("bootstrap plan snapshot handles subscription statuses explicitly", () => {
  const source = read("web/services/bootstrap/bootstrapQueryService.js");

  assert.ok(source.includes("PLAN_STATUSES_USING_STORED_PLAN"));
  assert.ok(source.includes("\"ACTIVE\""));
  assert.ok(source.includes("\"PENDING\""));
  assert.ok(source.includes("\"FROZEN\""));
  assert.ok(source.includes("PLAN_STATUSES_FALLING_BACK_TO_FREE"));
  assert.ok(source.includes("\"CANCELLED\""));
  assert.ok(source.includes("\"EXPIRED\""));
  assert.equal(source.includes("String(subscription.status || \"\").toUpperCase() === \"ACTIVE\""), false);
});

test("bootstrap query repository failures return safe bootstrap fallbacks", () => {
  const source = read("web/services/bootstrap/bootstrapQueryService.js");

  assert.ok(source.includes("BOOTSTRAP_OPERATION_SUMMARY_UNAVAILABLE"));
  assert.ok(source.includes("unavailable: true"));
  assert.ok(source.includes("return buildPlanSnapshot(null, true)"));
});
