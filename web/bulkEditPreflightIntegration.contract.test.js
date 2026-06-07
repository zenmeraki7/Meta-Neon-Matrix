import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("manual command runs unified preflight before creating history", () => {
  const source = read("web/services/bulkEdit/BulkEditCommandService.js");
  const preflightAt = source.indexOf("const preflight = runBulkEditPreflight");
  const returnAt = source.indexOf("return {", preflightAt);

  assert.ok(preflightAt > 0);
  assert.ok(returnAt > preflightAt);
  assert.match(source, /preflight,/);
});

test("execute worker reruns preflight before acquiring Shopify mutation slot", () => {
  const source = read("web/Jobs/Workers/bulkEditExecuteWorker.js");
  const preflightAt = source.indexOf("runBulkEditPreflight({");
  const slotAt = source.indexOf(
    "const bulkMutationSlot = await acquireShopifyBulkMutationSlot",
  );

  assert.ok(preflightAt > 0);
  assert.ok(slotAt > preflightAt);
  assert.match(source, /PREVIEW_MIRROR_BATCH_STALE/);
});

test("critical confirmation phrase reaches the execute request", () => {
  const page = read("web/frontend/Domain/products/edit/pages/EditPreviewPage.jsx");
  const dto = read("web/dtos/productBulkEditDto.js");
  const hook = read("web/frontend/Domain/products/edit/hooks/useEditPreviewQuery.js");

  assert.match(dto, /requiredCriticalConfirmation/);
  assert.match(hook, /requiredCriticalConfirmation/);
  assert.match(page, /criticalConfirmationText/);
  assert.match(page, /EDIT \$\{previewTotal\.toLocaleString/);
});
