import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (p) => fs.readFileSync(path.resolve(p), "utf8");

test("verification respects explicit mode before high-risk defaults", () => {
  const source = read("web/services/bulkEdit/BulkEditVerificationService.js");
  const configuredIndex = source.indexOf("const configured = String(history?.batch?.verificationMode");
  const fullIndex = source.indexOf("if (requiresFullVerification(history)) return VERIFY_MODES.FULL");
  assert.ok(configuredIndex > -1);
  assert.ok(fullIndex > -1);
  assert.ok(configuredIndex < fullIndex);
});

test("verification uses bounded deterministic samples instead of collecting all success rows", () => {
  const source = read("web/services/bulkEdit/BulkEditVerificationService.js");
  assert.ok(source.includes("MAX_VERIFICATION_ROWS_PER_RUN"));
  assert.ok(source.includes("resolveSampleLimit(history)"));
  assert.ok(source.includes("pushDeterministicSample(sampleRows, row, sampleLimit, seed)"));
  assert.equal(source.includes("let verifyRows = []"), false);
  assert.equal(source.includes("verifyRows.push(row)"), false);
  assert.equal(source.includes("verifyRows = [...verifyRows]"), false);
});

test("verification requires current batch id and does not query all batches", () => {
  const source = read("web/services/bulkEdit/BulkEditVerificationService.js");
  assert.ok(source.includes("VERIFICATION_REQUIRES_BATCH_ID"));
  assert.ok(source.includes("batchId,"));
  assert.equal(source.includes("...(batchId ? { batchId } : {})"), false);
});

test("verification throttles progress and bulk-updates failed rows", () => {
  const source = read("web/services/bulkEdit/BulkEditVerificationService.js");
  assert.ok(source.includes("PROGRESS_PAGE_INTERVAL"));
  assert.ok(source.includes("pageCount % Math.max(1, PROGRESS_PAGE_INTERVAL)"));
  assert.ok(source.includes("function markVerificationFailures"));
  assert.ok(source.includes("CASE ${caseClauses} ELSE"));
  assert.equal(source.includes("db.$transaction(\n        batch.map"), false);
});

test("verification caps inventory and metafield external request fanout", () => {
  const source = read("web/services/bulkEdit/BulkEditVerificationService.js");
  assert.ok(source.includes("MAX_INVENTORY_VARIANTS_PER_RUN"));
  assert.ok(source.includes("MAX_METAFIELD_REQUESTS_PER_RUN"));
  assert.ok(source.includes("budgetSkippedRowIds"));
  assert.ok(source.includes("budgetSkippedCount"));
  assert.ok(source.includes("inventoryRequests.size + newInventoryVariantCount"));
  assert.ok(source.includes("metafieldRequestMap.size + newMetafieldRequestCount"));
});

test("verification avoids intermediate mirror-updating transition", () => {
  const source = read("web/services/bulkEdit/BulkEditVerificationService.js");
  assert.equal(source.includes("movedToMirrorUpdating"), false);
  assert.equal(source.includes("EDIT_HISTORY_UPDATE_FAILED_SET_MIRROR_UPDATING"), false);
  assert.ok(source.includes("schedulePostMutationMirrorReconciliation"));
  assert.ok(source.includes("EDIT_HISTORY_UPDATE_FAILED_SET_VERIFICATION_RESULT"));
});

test("verification comparison preserves null and typed value semantics", () => {
  const source = read("web/services/bulkEdit/BulkEditVerificationService.js");
  assert.ok(source.includes("function valuesEquivalent"));
  assert.ok(source.includes("return current === wanted"));
  assert.equal(source.includes("String(current) !== String(wanted)"), false);
  assert.equal(source.includes("String(currentAvailable) !== String(wantedAvailable)"), false);
});
