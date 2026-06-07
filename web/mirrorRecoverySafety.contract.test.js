import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("mirror health is assessed continuously and unsafe mirrors queue automatic repair", () => {
  const health = read("web/services/mirrorHealthService.js");
  const reconciliation = read("web/Jobs/Workers/reconciliationWorker.js");

  assert.match(health, /export async function assessMirrorHealth/);
  assert.match(health, /NO_ACTIVE_BATCH/);
  assert.match(health, /ACTIVE_BATCH_EMPTY/);
  assert.match(health, /WEBHOOK_LAG/);
  assert.match(health, /FULL_SYNC_STALE/);
  assert.match(health, /export async function repairMirror/);
  assert.match(health, /reason: "MIRROR_REPAIR"/);
  assert.match(health, /reason: "BULK_EDIT_IN_PROGRESS"/);
  assert.match(reconciliation, /await assessMirrorHealth\(shop\)/);
  assert.match(reconciliation, /await repairMirror\(shop\)/);
});

test("bulk execution and mirror activation have independent safety gates", () => {
  const execute = read("web/Jobs/Workers/bulkEditExecuteWorker.js");
  const activation = read("web/repositories/productSyncRepository.js");

  assert.match(execute, /assertMirrorSafeForBulkExecution/);
  assert.ok(
    execute.indexOf("await assertMirrorSafeForBulkExecution")
      < execute.indexOf("const bulkMutationSlot = await acquireShopifyBulkMutationSlot"),
  );
  assert.match(activation, /expectedProducts \* 0\.99/);
  assert.match(activation, /MIRROR_BATCH_INTEGRITY_CHECK_FAILED/);
  assert.match(activation, /MIRROR_BATCH_ACTIVATION_DEFERRED_BULK_EDIT_IN_PROGRESS/);
});

test("bulk edit UI cannot execute against a non-healthy mirror", () => {
  const page = read("web/frontend/Domain/products/edit/pages/EditPreviewPage.jsx");

  assert.match(page, /mirrorHealthState !== "HEALTHY"/);
  assert.match(page, /mirrorExecutionBlocked/);
  assert.match(page, /DegradationBanner fallbackCode="MIRROR_UNSAFE"/);
});
