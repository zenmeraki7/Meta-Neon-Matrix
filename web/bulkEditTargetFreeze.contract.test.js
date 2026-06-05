import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (p) => fs.readFileSync(path.resolve(p), "utf8");

test("target freeze owns transaction and ignores caller supplied tx", () => {
  const source = read("web/services/bulkEdit/BulkEditTargetFreezeService.js");
  assert.ok(source.includes("return this.db.$transaction(async (db) =>"));
  assert.equal(source.includes("options?.tx"), false);
  assert.ok(source.includes("this.db = dependencies.db || defaultDb"));
});

test("target freeze has one snapshot set upsert and one attach path", () => {
  const source = read("web/services/bulkEdit/BulkEditTargetFreezeService.js");
  assert.equal((source.match(/this\.upsertFrozenSnapshotSetFromLegacy\(/g) || []).length, 1);
  assert.equal((source.match(/this\.attachFrozenSnapshotRefToFreezingHistory\(/g) || []).length, 1);
  assert.ok(source.includes("resolveSnapshotSetArgs"));
  assert.ok(source.includes("TARGET_SNAPSHOT_PROJECTION_VERSION"));
});

test("target freeze requires execution identity and blocks preview mismatch", () => {
  const source = read("web/services/bulkEdit/BulkEditTargetFreezeService.js");
  assert.ok(source.includes("TARGET_FREEZE_REQUIRES_EXECUTION_IDENTITY"));
  assert.ok(source.includes("PREVIEW_EXECUTION_TARGET_COUNT_MISMATCH"));
  assert.ok(source.includes("await assertPreviewCountMatches"));
  assert.equal(source.includes("operationId: String(history.executionIdentity"), false);
  assert.ok(source.includes("operationId: requireExecutionIdentity(history)"));
});

test("target freeze validates resolver and avoids generic PRODUCT_SET intent", () => {
  const source = read("web/services/bulkEdit/BulkEditTargetFreezeService.js");
  assert.ok(source.includes("resolveFreezeResolver"));
  assert.ok(source.includes("TARGET_FREEZE_RESOLVER_MISSING"));
  assert.ok(source.includes("resolver.bind(targetingEngine)"));
  assert.equal(source.includes('mutationType: "PRODUCT_SET"'), false);
  assert.ok(source.includes("mutationType: resolveOperationIntentName(history)"));
});

test("legacy filter params are constrained to recurring compatibility only", () => {
  const source = read("web/services/bulkEdit/BulkEditTargetFreezeService.js");
  assert.ok(source.includes("LEGACY_FILTER_PARAMS_ALLOWED_FOR_RECURRING_ONLY"));
  assert.ok(source.includes("&& isRecurringRun"));
  assert.ok(source.includes("&& !history.batch?.filterAst"));
});
