import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (p) => fs.readFileSync(path.resolve(p), "utf8");

test("characterization: product grid response DTO keys remain stable", () => {
  const routeSrc = read("web/routes/products.js");
  const serviceSrc = read("web/services/catalog/productGridQueryService.js");
  assert.ok(routeSrc.includes("jsonResponse(res, result);"));
  assert.ok(serviceSrc.includes("rows,"));
  assert.ok(serviceSrc.includes("nextCursor:"));
  assert.ok(serviceSrc.includes("total:"));
  assert.ok(serviceSrc.includes("variantId:"));
  assert.ok(serviceSrc.includes("productId:"));
  assert.ok(serviceSrc.includes("metafields:"));
});

test("characterization: variant grid response DTO keys remain stable", () => {
  const routeSrc = read("web/routes/variants.js");
  const serviceSrc = read("web/services/catalog/variantGridQueryService.js");
  assert.ok(routeSrc.includes("jsonResponse(res, result);"));
  assert.ok(serviceSrc.includes("rows: Array.from(grouped.values())"));
  assert.ok(serviceSrc.includes("nextCursor:"));
  assert.ok(serviceSrc.includes("isStale"));
  assert.ok(serviceSrc.includes("syncedAt:"));
  assert.ok(serviceSrc.includes("freshness:"));
  assert.ok(serviceSrc.includes("metafields:"));
});

test("characterization: sync start + status DTOs remain stable", () => {
  const controllerSrc = read("web/controllers/syncController.js");
  const dtoSrc = read("web/dtos/syncCommandResponseDto.js");
  const serviceSrc = read("web/services/sync/SyncCommandService.js");
  assert.ok(dtoSrc.includes("message:"));
  assert.ok(dtoSrc.includes("bulkOperationId: result?.bulkOperationId"));
  assert.ok(dtoSrc.includes("syncHistoryId: result?.syncHistoryId"));
  assert.ok(dtoSrc.includes("syncBatchId: result?.syncBatchId"));
  assert.ok(serviceSrc.includes('message: "Product sync started"'));
  assert.ok(controllerSrc.includes("getSyncStatus"));
  assert.ok(controllerSrc.includes("getSyncStatusSummary"));
  assert.ok(controllerSrc.includes("trackProductSync"));
});

test("characterization: bootstrap dashboard summary DTO remains stable", () => {
  const src = read("web/controllers/bootstrapController.js");
  assert.ok(src.includes("getDashboardBootstrap"));
  assert.ok(src.includes("storeDetails:"));
  assert.ok(src.includes("syncStatus:"));
  assert.ok(src.includes("operationSummary:"));
  assert.ok(src.includes("planSnapshot:"));
  assert.ok(src.includes("currentPlanKey"));
  assert.ok(src.includes("plans"));
});

test("characterization: subscription plan snapshot DTO remains stable", () => {
  const controllerSrc = read("web/controllers/subscriptionController.js");
  const serviceSrc = read("web/services/subscription/SubscriptionQueryService.js");
  assert.ok(controllerSrc.includes("getPlansController"));
  assert.ok(controllerSrc.includes("currentPlanKey"));
  assert.ok(controllerSrc.includes("plans"));
  assert.ok(serviceSrc.includes("isCurrent"));
});

test("characterization: session change staging DTO remains stable", () => {
  const routeSrc = read("web/routes/changes.js");
  const useCaseSrc = read("web/useCases/sessionChangeUseCases.js");
  assert.ok(routeSrc.includes("router.post(\"/:id/changes\", stageChangesHandler);"));
  assert.ok(routeSrc.includes("router.post(\"/:id/changes/column-apply\", columnApplyHandler);"));
  assert.ok(routeSrc.includes("jsonResponse(res, result, 201);"));
  assert.ok(useCaseSrc.includes("return { staged: changes.length };"));
  assert.ok(useCaseSrc.includes("return { staged: Number(result?.staged || 0) };"));
});

test("characterization: session commit flow DTO remains stable", () => {
  const routeSrc = read("web/routes/commit.js");
  const useCaseSrc = read("web/useCases/commitBulkEditSessionUseCase.js");
  const jobCreationSrc = read("web/services/JobCreationService.js");
  assert.ok(routeSrc.includes("router.post(\"/:id/commit\", commitSessionHandler);"));
  assert.ok(routeSrc.includes("jsonResponse(res, result);"));
  assert.ok(useCaseSrc.includes("jobId:"));
  assert.ok(useCaseSrc.includes("sessionId:"));
  assert.ok(useCaseSrc.includes("changeCount:"));
  assert.ok(jobCreationSrc.includes('"BULK_WRITE"'));
});
