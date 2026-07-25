import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("bulk-operation completion is delivered to the mounted Shopify webhook handler", () => {
  const appConfig = read("shopify.app.toml");
  const app = read("web/app.js");

  assert.match(appConfig, /topics\s*=\s*\[\s*"bulk_operations\/finish"\s*\]/);
  assert.match(appConfig, /uri\s*=\s*"\/api\/webhooks"/);
  assert.match(app, /shopify\.config\.webhooks\.path/);
  assert.match(app, /shopify\.processWebhooks/);
});

test("development starts both web and durable queue worker processes", () => {
  const packageJson = JSON.parse(read("web/package.json"));
  const worker = read("web/worker.js");

  assert.match(packageJson.scripts.dev, /npm:dev:web/);
  assert.match(packageJson.scripts.dev, /npm:dev:worker/);
  assert.match(packageJson.scripts["dev:web"], /WEB_PROCESS=true/);
  assert.match(packageJson.scripts["dev:worker"], /WORKER_PROCESS=true/);
  assert.doesNotMatch(worker, /requiredEnv\s*=\s*\[[\s\S]*"SCOPES"/);
});

test("shared worker bootstrap imports recurring queue identity from its owning adapter", () => {
  const worker = read("web/Jobs/Workers/recurringEditExecutionWorker.js");

  assert.match(worker, /RECURRING_EDIT_EXECUTION_QUEUE.*recurringEditQueueAdapter\.js/s);
  assert.doesNotMatch(
    worker,
    /RECURRING_EDIT_EXECUTION_QUEUE[\s\S]*from\s+"\.\.\/\.\.\/services\/recurringEditExecutionService\.js"/,
  );
});

test("shared worker bootstrap imports scheduled export queue identity from its owning adapter", () => {
  const worker = read("web/Jobs/Workers/scheduledExportExecutionWorker.js");

  assert.match(worker, /SCHEDULED_EXPORT_EXECUTION_QUEUE.*scheduledExportQueueAdapter\.js/s);
  assert.doesNotMatch(
    worker,
    /SCHEDULED_EXPORT_EXECUTION_QUEUE[\s\S]*from\s+"\.\.\/\.\.\/services\/scheduledExportExecutionService\.js"/,
  );
});

test("automatic rule workers import queue identities from their owning adapter", () => {
  const executionWorker = read("web/Jobs/Workers/automaticProductRuleExecutionWorker.js");
  const signalWorker = read("web/Jobs/Workers/automaticProductRuleSignalWorker.js");

  assert.match(executionWorker, /AUTOMATIC_PRODUCT_RULE_EXECUTION_QUEUE.*automaticRuleQueueAdapter\.js/s);
  assert.match(signalWorker, /AUTOMATIC_PRODUCT_RULE_SIGNAL_QUEUE.*automaticRuleQueueAdapter\.js/s);
});

test("catalog polling readiness returns Prisma-supported text and cannot crash worker boot", () => {
  const worker = read("web/Jobs/Workers/catalogMissedUpdatesPollingWorker.js");

  assert.match(worker, /to_regclass\([\s\S]*\)::text AS regclass/);
  assert.match(worker, /registerRepeatableTick\(\)\.catch/);
});

test("sync cursor writes ensure the legacy shops foreign key parent", () => {
  const cursors = read("web/db/syncCursors.js");

  assert.match(cursors, /async function ensureSyncCursorShop/);
  assert.match(cursors, /prisma\.shop\.upsert/);
  assert.match(cursors, /await ensureSyncCursorShop\(shop\)/);
});

test("sync status exposes the persisted start timestamp used for stale recovery", () => {
  const repository = read("web/repositories/storeRepository.js");
  const service = read("web/services/syncStatusQueryService.js");

  assert.match(repository, /productSyncStartedAt:\s*true/);
  assert.match(service, /productSyncStartedAt:\s*storeState\.productSyncStartedAt/);
});

test("product table renders the React Query response without a Redux hydration dependency", () => {
  const page = read("web/frontend/Domain/products/list/pages/Products.jsx");
  const table = read("web/frontend/Domain/products/list/components/ProductsTable.jsx");

  assert.match(page, /<ProductsTable[\s\S]*products=\{products\}/);
  assert.match(table, /products\s*=\s*\[\]/);
  assert.doesNotMatch(table, /useSelector|makeSelectProductRowViewModel/);
});

test("products bootstrap responses opt out of browser and intermediary caching", () => {
  const controller = read("web/controllers/bootstrapController.js");

  assert.match(controller, /setPrivateNoStore\(res\)/);
});

test("mirror activation resolves reconciliation signals with the Prisma schema field", () => {
  const repository = read("web/repositories/productSyncRepository.js");

  assert.match(repository, /mirrorReconcileSignal\.updateMany[\s\S]*reconciliationCompletedAt:\s*completedAt/);
  assert.doesNotMatch(repository, /mirrorReconcileSignal\.updateMany[\s\S]*resolvedAt:\s*completedAt/);
  assert.match(repository, /recordCount:\s*finalProductCount,[\s\S]*completedAt/);
  assert.match(repository, /lastProductSyncAt:\s*completedAt,[\s\S]*productSyncStartedAt:\s*null/);
});

test("failed refresh preserves an activated mirror for read-only product previews", () => {
  const syncRepository = read("web/repositories/productSyncRepository.js");
  const storeRepository = read("web/repositories/storeRepository.js");
  const productPage = read("web/frontend/Domain/products/list/pages/Products.jsx");

  assert.match(syncRepository, /mirrorHealthState:\s*hasActivatedMirror \? "DEGRADED" : "UNSAFE"/);
  assert.match(syncRepository, /requiresMirrorRepair:\s*!hasActivatedMirror/);
  assert.match(storeRepository, /recoverFailedProductSyncActivatedMirror\.updateMany/);
  assert.match(storeRepository, /restoredActivatedMirrorPreview:\s*true/);
  assert.match(productPage, /shouldShowMirrorUnavailableState/);
  assert.match(productPage, /Product mirror needs repair/);
  assert.match(productPage, /!isProductMirrorUnavailable/);
});
