import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (file) => fs.readFileSync(file, "utf8");
const schema = read("web/prisma/schema.prisma");
const model = (name) => schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] || "";

test("mirror children have consistent source, reconciliation and deletion metadata", () => {
  for (const name of ["Product", "Variant", "Collection", "InventoryItemMirror", "InventoryLevelMirror", "MetafieldMirror", "ProductMediaMirror", "ProductCollection"]) {
    const body = model(name);
    assert.match(body, /sourceVersion\s+String\?/);
    assert.match(body, /reconciliationCompletedAt\s+DateTime\?/);
    assert.match(body, /isDeleted\s+Boolean/);
  }
  const writer = read("web/services/productService/productSyncService.js");
  assert.match(writer, /productCollectionRows\.push\([\s\S]*sourceEntityUpdatedAt:[\s\S]*lastChangeSource: "BULK_SYNC"/);
  assert.match(writer, /productMediaRows\.push\([\s\S]*sourceEntityUpdatedAt:[\s\S]*lastChangeSource: "BULK_SYNC"/);
});

test("undo and terminal projections are tenant-scoped", () => {
  assert.match(model("UndoOperation"), /fields: \[shop, previewContractId\], references: \[shop, id\], onDelete: Restrict/);
  assert.match(model("TerminalProjection"), /shop\s+String/);
  assert.match(model("TerminalProjection"), /@@unique\(\[shop, sourceType, sourceId, sourceVersion, targetType\]/);
  assert.match(model("RunFinalizationIntent"), /shop\s+String/);
  assert.match(model("RunFinalizationIntent"), /@@unique\(\[shop, kind, sourceId, sourceVersion, targetRunId\]\)/);
});

test("global models remain global and lease APIs support stale-fence rejection", () => {
  for (const name of ["Suggestion", "AffiliateUser", "PlanEntitlement"]) {
    assert.doesNotMatch(model(name), /^\s*shop\s+String/m);
  }
  const lease = read("web/services/operationLeaseService.js");
  assert.match(lease, /fencingToken !== null[\s\S]*lease\.fencingToken !== BigInt\(fencingToken\)/);
  assert.match(lease, /operation_lease_fencing_token_mismatch/);
});

test("FilterTrack no longer stores subscription commands", () => {
  const commandService = read("web/services/subscription/SubscriptionCommandService.js");
  const worker = read("web/Jobs/Workers/subscriptionBillingWorker.js");
  assert.match(schema, /model SubscriptionCommand \{/);
  assert.match(commandService, /db\.subscriptionCommand/);
  assert.doesNotMatch(commandService, /db\.filterTrack/);
  assert.match(worker, /db\.subscriptionCommand/);
  assert.doesNotMatch(worker, /db\.filterTrack/);
});

test("legacy retirement decisions have explicit runtime evidence and gates", () => {
  const evidence = read("web/docs/model-disposition-evidence.md");
  assert.match(evidence, /Legacy metafield\/session pipeline: not eligible for removal/);
  assert.match(evidence, /metafieldBulkWriteWorker\.js/);
  assert.match(evidence, /OperationStageProgress: retain/);
  assert.match(evidence, /FilterTrack split status/);
});
