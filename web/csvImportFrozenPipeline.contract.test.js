import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(".");

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), "utf8");
}

test("csv import worker freezes explicit targets before execute", () => {
  const source = read("web/Jobs/Workers/bulkImportEditWorker.js");
  assert.ok(source.includes("freezeExplicitTargetSet("));
  assert.ok(source.includes("finalizeFrozenSnapshotSet("));
  assert.ok(source.includes("snapshotSetId: snapshotSet.id"));
  assert.ok(source.includes("targetSnapshotRef"));
  assert.ok(source.includes("addBulkEditExecuteJob("));
  assert.ok(!source.includes("service._bulkOperationHelper("));
});

test("csv import worker scopes mirror reads to active mirror batch", () => {
  const source = read("web/Jobs/Workers/bulkImportEditWorker.js");
  assert.ok(source.includes("getActiveMirrorBatchId("));
  assert.ok(source.includes("purpose: \"CSV_IMPORT_PREPARE\""));
  assert.ok(source.includes("mirrorBatchId,"));
});

test("csv import prepare allows readable degraded mirror without treating it as live execution", () => {
  const targeting = read("web/services/productService/productTargetingService.js");

  assert.ok(targeting.includes("CSV_IMPORT_PREPARE"));
  assert.ok(targeting.includes("readableMirrorUnsafe"));
  assert.ok(targeting.includes("mirrorHealthState !== \"HEALTHY\""));
});

test("execution preparation reads csv rows from frozen-target products only", () => {
  const source = read("web/services/bulkEdit/BulkEditExecutionPreparationService.js");
  assert.ok(source.includes("history.batch?.csvImport === true"));
  assert.ok(source.includes("db.changeRecord.findMany"));
  assert.ok(source.includes("fields: [\"mixed\"]"));
});

test("csv history writes immutable edit command envelope", () => {
  const source = read("web/services/productImport/ProductImportCommandService.js");
  assert.ok(source.includes("buildImmutableEditCommand("));
  assert.ok(source.includes("operator: \"CSV_IMPORT\""));
});

test("csv import and execute queues use canonical queue names", () => {
  const queueNames = read("web/queues/queueNames.js");
  const adapter = read("web/queues/adapters/jobsQueueInstancesAdapter.js");
  const importWorker = read("web/Jobs/Workers/bulkImportEditWorker.js");
  const executeWorker = read("web/Jobs/Workers/bulkEditExecuteWorker.js");

  assert.ok(queueNames.includes("CSV_IMPORT_PREPARE"));
  assert.ok(queueNames.includes("BULK_EDIT_EXECUTE"));
  assert.ok(queueNames.includes("APP_QUEUE_NAMESPACE"));
  assert.ok(queueNames.includes("meta-neon-matrix"));
  assert.ok(adapter.includes("QUEUE_NAMES.CSV_IMPORT_PREPARE"));
  assert.ok(adapter.includes("QUEUE_NAMES.BULK_EDIT_EXECUTE"));
  assert.ok(importWorker.includes("QUEUE_NAMES.CSV_IMPORT_PREPARE"));
  assert.ok(executeWorker.includes("QUEUE_NAMES.BULK_EDIT_EXECUTE"));
});

test("csv import server rejects unknown mapping fields", () => {
  const normalizer = read("web/normalizers/productImportCommandNormalizer.js");
  const registry = read("web/services/productImport/importFieldRegistry.js");

  assert.ok(normalizer.includes("isAllowedImportFieldKey"));
  assert.ok(normalizer.includes("UNKNOWN_IMPORT_MAPPING_FIELD"));
  assert.ok(registry.includes("IMPORT_FIELD_REGISTRY"));
  assert.ok(registry.includes("variant_id"));
});

test("csv import worker validates trusted product and variant identities", () => {
  const source = read("web/Jobs/Workers/bulkImportEditWorker.js");

  assert.ok(source.includes("PRODUCT_GID_RE"));
  assert.ok(source.includes("VARIANT_GID_RE"));
  assert.ok(source.includes("DUPLICATE_IMPORT_IDENTITY"));
  assert.ok(source.includes("CSV_IMPORT_PRODUCT_NOT_FOUND_IN_SHOP"));
  assert.ok(source.includes("CSV_IMPORT_VARIANT_NOT_IN_PRODUCT"));
});

test("csv import supports product create rows without Product ID", () => {
  const worker = read("web/Jobs/Workers/bulkImportEditWorker.js");
  const normalizer = read("web/normalizers/productImportCommandNormalizer.js");
  const importUtils = read("web/utils/importEditUtils.js");

  assert.ok(!worker.includes("CSV_IMPORT_PRODUCT_ID_MAPPING_REQUIRED"));
  assert.ok(!normalizer.includes("PRODUCT_ID_MAPPING_REQUIRED"));
  assert.ok(worker.includes("PRODUCT_TITLE_REQUIRED"));
  assert.ok(worker.includes("buildCsvCreateProductId"));
  assert.ok(worker.includes("csvCreate"));
  assert.ok(importUtils.includes("...(productSet.id && { id: productSet.id })"));
});

test("csv import writes execution plan before queueing execute worker", () => {
  const worker = read("web/Jobs/Workers/bulkImportEditWorker.js");

  assert.ok(worker.includes("buildExecutionPlanForEdit"));
  assert.ok(worker.includes("buildCsvImportExecutionPlan"));
  assert.ok(worker.includes('operationKey: "CSV_IMPORT_SET"'));
  assert.ok(worker.includes("executionPlan,"));
  assert.ok(worker.includes("operationKey: executionPlan.operationKey"));
});

test("csv import operation key is registered for productSet planning", () => {
  const registry = read("web/services/bulkEdit/planner/productEditOperationRegistry.js");

  assert.ok(registry.includes("CSV_IMPORT_SET"));
  assert.ok(registry.includes('mutation: "productSet"'));
});

test("execute worker can consume a freshly frozen csv snapshot race-safely", () => {
  const source = read("web/Jobs/Workers/bulkEditExecuteWorker.js");

  assert.ok(source.includes("OPERATION_LIFECYCLE_STATES.TARGET_FROZEN"));
  assert.ok(source.includes("OPERATION_SNAPSHOT_SET_UNBOUND"));
  assert.ok(source.includes("SNAPSHOT_SET_ID_REQUIRED"));
});
