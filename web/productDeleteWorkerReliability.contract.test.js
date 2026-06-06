import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("product delete validates the installed shop and scopes deletes to the active batch", () => {
  const source = read("web/Jobs/Workers/productDeleteWorker.js");
  const transaction = source.slice(
    source.indexOf("const deletion = await db.$transaction"),
    source.indexOf("if (deletion.skipped)"),
  );

  assert.match(transaction, /tx\.store\.findUnique/);
  assert.match(transaction, /isUnInstalled: true/);
  assert.match(transaction, /reason: "shop_not_installed"/);
  assert.match(transaction, /reason: "missing_active_mirror_batch"/);
  assert.equal((transaction.match(/mirrorBatchId: activeMirrorBatchId/g) || []).length, 2);
});

test("product delete rejects malformed IDs and distinguishes duplicate delivery", () => {
  const source = read("web/Jobs/Workers/productDeleteWorker.js");

  assert.match(source, /typeof id !== "string"/);
  assert.match(source, /typeof id !== "number"/);
  assert.match(source, /\/\^\\d\+\$\/\.test\(numericId\)/);
  assert.match(source, /reason: "already_deleted"/);
  assert.match(source, /deleted: deletion\.deleted/);
});

test("product delete rate limiting is inside its error boundary", () => {
  const source = read("web/Jobs/Workers/productDeleteWorker.js");

  assert.ok(source.indexOf("try {") < source.indexOf("await enforceShopRateLimit"));
  assert.ok(source.indexOf("await enforceShopRateLimit") < source.indexOf("} catch (error)"));
});

test("product webhook queues share constants and delete has lifecycle controls", () => {
  const source = read("web/Jobs/Workers/productDeleteWorker.js");
  const createSource = read("web/Jobs/Workers/productCreateWorker.js");
  const adapter = read("web/queues/adapters/jobsQueueInstancesAdapter.js");
  const constants = read("web/queues/productWebhookQueue.constants.js");

  assert.match(constants, /PRODUCT_CREATE_QUEUE_NAME/);
  assert.match(constants, /PRODUCT_UPDATE_QUEUE_NAME/);
  assert.match(constants, /PRODUCT_DELETE_QUEUE_NAME/);
  assert.match(createSource, /PRODUCT_CREATE_QUEUE_NAME/);
  assert.match(source, /PRODUCT_DELETE_QUEUE_NAME/);
  assert.match(adapter, /PRODUCT_DELETE_QUEUE_NAME/);
  assert.match(source, /lockDuration:/);
  assert.match(source, /new QueueEvents/);
  assert.match(source, /productDeleteDlqQueue\.add/);
  assert.match(source, /SIGTERM/);
});

test("product delete only advances health and clears caches after a real change", () => {
  const source = read("web/Jobs/Workers/productDeleteWorker.js");

  assert.ok(source.indexOf("if (!deletion.changed)") < source.indexOf("await markWebhookProcessed"));
  assert.match(source, /await Promise\.all\(\[/);
  assert.match(source, /Product delete cache invalidation failed/);
});
