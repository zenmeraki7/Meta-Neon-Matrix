import fs from "fs";
import path from "path";
import test from "node:test";
import assert from "node:assert/strict";

const root = process.cwd();

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), "utf8");
}

test("product sync worker no longer uses Date.now-based destructive job ids", () => {
  const src = read("web/Jobs/Workers/productSyncWorker.js");
  assert.ok(src.includes("buildProductSyncJobId"));
  assert.ok(src.includes("product-sync:"));
  assert.equal(src.includes("sync-${store.shopUrl}-${Date.now()}"), false);
  assert.equal(src.includes("priority-sync-${store.shopUrl}-${Date.now()}"), false);
});

test("shop sync queue persists durable mirror-sync ledger and canonical job id", () => {
  const src = read("web/Jobs/Queues/shopSyncJob.js");
  assert.ok(src.includes("operationType: \"MIRROR_SYNC\""));
  assert.ok(src.includes("joinSafeJobId(\"shop-sync\", data.shop, syncOperationId)"));
  assert.ok(src.includes("syncOperationId"));
});

test("bulk operation mutation worker persists unresolved mutation deliveries", () => {
  const src = read("web/Jobs/Workers/bulkOperationMutationWorker.js");
  assert.ok(src.includes("persistUnresolvedBulkMutationDelivery"));
  assert.ok(src.includes("bulk_operations/finish_unresolved"));
  assert.ok(src.includes("UNRESOLVED_BULK_OPERATION_OWNER"));
});

test("shop sync worker transitions durable mirror-sync ledger through starting/running/failed", () => {
  const src = read("web/Jobs/Workers/shopSyncWorker.js");
  assert.ok(src.includes("STARTING_BULK_QUERY"));
  assert.ok(src.includes("to: \"RUNNING\""));
  assert.ok(src.includes("to: \"FAILED\""));
  assert.ok(src.includes("operationType: MIRROR_SYNC_OPERATION_TYPE"));
});

test("product sync finalizer helper advances mirror-sync ledger to ingesting/completed", () => {
  const src = read("web/helpers/webhookHelpers/bulkOperations/productTypeSync.js");
  assert.ok(src.includes("to: \"INGESTING\""));
  assert.ok(src.includes("to: \"COMPLETED\""));
  assert.ok(src.includes("to: \"FAILED\""));
});

test("product sync refuses to activate an empty replacement mirror batch", () => {
  const src = read("web/services/productService/productSyncService.js");
  assert.ok(src.includes("Refusing to activate empty product mirror batch"));
  assert.ok(src.includes("previousProductCount"));
  assert.ok(src.includes("hasExistingMirror"));
});

test("product sync blocks suspicious partial replacement mirror batches", () => {
  const src = read("web/services/productService/productSyncService.js");
  assert.ok(src.includes("SUSPICIOUS_PARTIAL_PRODUCT_SYNC_THRESHOLD"));
  assert.ok(src.includes("partial_product_sync_suspect"));
  assert.ok(src.includes("Refusing to activate suspicious partial product mirror batch"));
});

test("legacy SQL product mirror upserts ignore stale Shopify payloads", () => {
  const src = read("db/products.js");
  assert.ok(src.includes("EXCLUDED.shopify_updated_at >= products.shopify_updated_at"));
  assert.ok(src.includes("EXCLUDED.shopify_updated_at >= variants.shopify_updated_at"));
});

test("product sync repository terminal paths also advance mirror-sync ledger", () => {
  const src = read("web/repositories/productSyncRepository.js");
  assert.ok(src.includes("transitionMirrorSyncLedgerBySyncHistoryId"));
  assert.ok(src.includes("to: \"INGESTING\""));
  assert.ok(src.includes("to: \"FAILED\""));
  assert.ok(src.includes("to: \"COMPLETED\""));
});

test("product mirror activation preserves webhook-newer previous batch rows before cleanup", () => {
  const src = read("web/repositories/productSyncRepository.js");
  assert.ok(src.includes("preserveNewerPreviousBatchProducts"));
  assert.ok(src.includes("previous_product.\"updatedAt\" > staged_product.\"updatedAt\""));
  assert.ok(src.indexOf("preserveNewerPreviousBatchProducts") < src.indexOf("activeMirrorBatchId: syncBatchId"));
});

test("Prisma product webhook workers guard stale writes atomically", () => {
  const updateSrc = read("web/Jobs/Workers/productUpdateWorker.js");
  const createSrc = read("web/Jobs/Workers/productCreateWorker.js");

  assert.ok(updateSrc.includes("updatedAt: { lte: incomingUpdatedAt }"));
  assert.ok(updateSrc.includes("stale_product_update_webhook"));
  assert.ok(createSrc.includes("new Date(current.updatedAt) > incomingUpdatedAt"));
  assert.ok(createSrc.includes("stale_product_create_webhook"));
});

test("unresolved recovery worker is bootstrapped and scans unresolved webhook deliveries", () => {
  const workerSrc = read("web/Jobs/Workers/unresolvedBulkOperationRecoveryWorker.js");
  const bootstrapSrc = read("web/worker.js");
  assert.ok(workerSrc.includes("bulk_operations/finish_unresolved"));
  assert.ok(workerSrc.includes("addbulkEditResultIngestJob"));
  assert.ok(workerSrc.includes("addbulkUndoResultIngestJob"));
  assert.ok(bootstrapSrc.includes("unresolvedBulkOperationRecoveryWorker.js"));
});

test("enqueue intent service uses PENDING -> DISPATCHING -> DISPATCHED naming", () => {
  const src = read("web/services/operationEnqueueIntentService.js");
  assert.ok(src.includes("DISPATCHING"));
  assert.equal(src.includes("status: \"PROCESSING\""), false);
});

test("scheduled export execution uses canonical scheduled-export-run job ids with forensic retention", () => {
  const src = read("web/services/scheduledExportExecutionService.js");
  assert.ok(src.includes("scheduledExportRunJobId("));
  assert.equal(src.includes("joinSafeJobId(runId, \"retry\")"), false);
  assert.ok(src.includes("removeOnComplete: { age: 7 * 24 * 3600, count: 5000 }"));
  assert.ok(src.includes("removeOnFail: { age: 30 * 24 * 3600, count: 20000 }"));
});

test("automatic rule execution queue uses deterministic run job id and forensic retention", () => {
  const src = read("web/services/automaticProductRuleExecutionService.js");
  assert.ok(src.includes("buildAutomaticRuleRunJobId"));
  assert.ok(src.includes("removeOnComplete: { age: 7 * 24 * 3600, count: 5000 }"));
  assert.ok(src.includes("removeOnFail: { age: 30 * 24 * 3600, count: 20000 }"));
});

test("automatic rule manual execution key no longer uses random uuid", () => {
  const src = read("web/services/automaticProductRuleExecutionService.js");
  const start = src.indexOf("function buildManualExecutionKey");
  const end = src.indexOf("function getExecutionTargetsForAutomaticRule");
  const manualFn = src.slice(start, end);
  assert.equal(manualFn.includes("crypto.randomUUID()"), false);
  assert.ok(src.includes("manual:"));
});

test("scheduled export finalization writes history only after run transition CAS succeeds", () => {
  const src = read("web/services/scheduledExportExecutionService.js");
  assert.ok(src.includes("if (!transition.count) {"));
  const transitionPos = src.indexOf("if (!transition.count) {");
  const createHistoryPos = src.indexOf("await prisma.exportHistory.create");
  assert.ok(transitionPos > -1);
  assert.ok(createHistoryPos > transitionPos);
});

test("unresolved bulk recovery claims rows via QUEUED -> DISPATCHING CAS", () => {
  const src = read("web/Jobs/Workers/unresolvedBulkOperationRecoveryWorker.js");
  assert.ok(src.includes("status: \"DISPATCHING\""));
  assert.ok(src.includes("claimed.count !== 1"));
  assert.ok(src.includes("where: { id: row.id, status: \"DISPATCHING\" }"));
});

test("operation enqueue intent transitions are shop-scoped", () => {
  const src = read("web/services/operationEnqueueIntentService.js");
  assert.ok(src.includes("shop,"));
  assert.ok(src.includes("status: ENQUEUE_INTENT_STATUS.DISPATCHING"));
});

test("bulk export cursor checkpoint is guarded with updateMany CAS", () => {
  const src = read("web/Jobs/Workers/bulkExportWorker.js");
  assert.ok(src.includes("EXPORT_CURSOR_CHECKPOINT_REJECTED"));
  assert.ok(src.includes("executionCursorOrdinal: cursorOrdinal"));
  assert.ok(src.includes("updateMany"));
});

test("legacy product sync repeatable setup is blocked in production", () => {
  const src = read("web/Jobs/Queues/productSyncQueue.js");
  assert.ok(src.includes("retired_legacy_repeatable_setup"));
  assert.ok(src.includes("process.env.NODE_ENV === \"production\""));
});

test("product sync service streams per-product without full productsMap accumulation", () => {
  const src = read("web/services/productService/productSyncService.js");
  assert.equal(src.includes("const productsMap = new Map()"), false);
  assert.ok(src.includes("let currentProduct = null"));
  assert.ok(src.includes("await finalizeCurrentProduct()"));
  assert.ok(src.includes("await flushProductsAndVariants()"));
});

test("target freeze worker uses CAS guards for DISPATCHING->DISPATCHED and rollback", () => {
  const src = read("web/Jobs/Workers/targetFreezeQueueWorker.js");
  assert.ok(src.includes("status: TARGET_FREEZE_COMMAND_STATUS.DISPATCHING"));
  assert.ok(src.includes("TARGET_FREEZE_DISPATCH_TRANSITION_REJECTED"));
  assert.ok(src.includes("updateMany"));
  assert.equal(src.includes("targetFreezeCommand.update({"), false);
});

test("scheduled edit recovery uses deterministic recovery-dispatch job id", () => {
  const src = read("web/Jobs/Workers/scheduledEditRecoveryWorker.js");
  assert.ok(src.includes("\"scheduled-edit-recovery-dispatch\""));
});
