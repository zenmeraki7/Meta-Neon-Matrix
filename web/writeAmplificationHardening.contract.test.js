import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

test("enqueue intents atomically claim and reclaim stale dispatches", () => {
  const source = read("./services/operationEnqueueIntentService.js");
  assert.match(source, /FOR UPDATE SKIP LOCKED/);
  assert.match(source, /UPDATE "OperationEnqueueIntent" intent/);
  assert.match(source, /dispatchHeartbeatAt/);
  assert.match(source, /COALESCE\("dispatchHeartbeatAt", "dispatchStartedAt", "updatedAt"\)/);
  assert.match(source, /options\.jobId/);
  assert.match(source, /dispatchOwnerId/);
  assert.match(source, /status: ENQUEUE_INTENT_STATUS\.PENDING/);
  assert.match(source, /shop: intent\.shop/);
});

test("product deletion removes inventory levels with one scoped statement", () => {
  const source = read("./Jobs/Workers/productDeleteWorker.js");
  assert.match(source, /DELETE FROM "InventoryLevelMirror" level/);
  assert.match(source, /level\."mirrorBatchId" = item\."mirrorBatchId"/);
  assert.doesNotMatch(source, /for \(const item of inventoryItems\)/);
});

test("catalog polling batches metafields and journals one mutation per product", () => {
  const source = read("./Jobs/Workers/catalogMissedUpdatesPollingWorker.js");
  assert.match(source, /jsonb_to_recordset/);
  assert.match(source, /METAFIELDS_RECONCILED/);
  assert.doesNotMatch(source, /mutationType: "METAFIELD_UPSERT"/);
});

test("product list does not eagerly request variants", () => {
  const source = read("./frontend/Domain/products/list/pages/Products.jsx");
  assert.doesNotMatch(source, /variants-grid/);
  assert.doesNotMatch(source, /\/api\/variants\/query/);
  const repository = read("./repositories/productQueryRepository.js");
  const listing = repository.slice(
    repository.indexOf("findProductsForListing"),
    repository.indexOf("export async function countProducts"),
  );
  assert.doesNotMatch(listing, /variants/);
});

test("product and variant reconciliation use set-based upserts", () => {
  const bulkApply = read("./services/bulkEdit/BulkEditMirrorApplyService.js");
  const webhook = read("./repositories/mirrorMutationRepository.js");
  assert.match(bulkApply, /jsonb_to_recordset/);
  assert.match(bulkApply, /ON CONFLICT \("shop", "id", "mirrorBatchId"\)/);
  assert.match(webhook, /jsonb_to_recordset/);
  assert.doesNotMatch(webhook, /for \(const variant of variants\)/);
  const applySection = bulkApply.slice(
    bulkApply.indexOf("export async function applyMirrorFromSuccessfulChangeRecords"),
    bulkApply.indexOf("function productDataFromShopify"),
  );
  assert.match(applySection, /UPDATE "ChangeRecord" change/);
  assert.doesNotMatch(applySection, /db\.product\.updateMany/);
  assert.doesNotMatch(applySection, /db\.variant\.updateMany/);
  assert.match(bulkApply, /MAX_SET_BASED_ROWS = 500/);
  assert.match(webhook, /variants\.length > 500/);
  assert.match(bulkApply, /product\."shop" = \$\{shop\}/);
  assert.match(bulkApply, /variant\."shop" = \$\{shop\}/);
  assert.match(bulkApply, /change\."shop" = \$\{shop\}/);
});

test("cold product navigation defers overlapping prerequisite requests", () => {
  const products = read("./frontend/Domain/products/list/pages/Products.jsx");
  const syncHook = read("./frontend/hooks/useSyncStatusQuery.js");
  const storeHook = read("./frontend/hooks/useStoreDetailsQuery.js");
  assert.match(products, /enabled: bootstrapQuery\.isSuccess \|\| bootstrapQuery\.isError/);
  assert.match(syncHook, /options\?\.enabled \?\? true/);
  assert.match(storeHook, /enabled: options\?\.enabled \?\? true/);
});
