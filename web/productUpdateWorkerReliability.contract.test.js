import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("product update validates installed shop and exits on missing variants", () => {
  const source = read("web/Jobs/Workers/productUpdateWorker.js");
  assert.match(source, /isUnInstalled: true/);
  assert.match(source, /reason: "shop_not_installed"/);
  assert.match(source, /reason: "missing_variants_repair_scheduled"/);
  assert.match(source, /reason: "missing_updated_at_repair_scheduled"/);
});

test("product update batches partial variant refresh without deleting omitted variants", () => {
  const source = read("web/Jobs/Workers/productUpdateWorker.js");
  assert.doesNotMatch(source, /tx\.variant\.upsert/);
  assert.match(source, /productId: id/);
  assert.match(source, /id: \{ in: incomingIds \}/);
  assert.doesNotMatch(source, /id: \{ notIn: incomingIds \}/);
  assert.match(source, /tx\.variant\.createMany/);
});

test("product update shares its queue constant and has worker lifecycle controls", () => {
  const source = read("web/Jobs/Workers/productUpdateWorker.js");
  const adapter = read("web/queues/adapters/jobsQueueInstancesAdapter.js");
  assert.match(source, /PRODUCT_UPDATE_QUEUE_NAME/);
  assert.match(adapter, /PRODUCT_UPDATE_QUEUE_NAME/);
  assert.match(source, /lockDuration:/);
  assert.match(source, /stalledInterval:/);
  assert.match(source, /new QueueEvents/);
  assert.match(source, /SIGTERM/);
  assert.match(source, /productUpdateDlqQueue\.add/);
});

test("webhook timestamp does not default missing updated_at to now", () => {
  const source = read("web/utils/webhookTransformers.js");
  assert.match(source, /updatedAt: payload\.updated_at \? new Date\(payload\.updated_at\) : null/);
});

test("product update cache invalidation is parallel and best effort", () => {
  const source = read("web/Jobs/Workers/productUpdateWorker.js");
  assert.match(source, /await Promise\.all\(\[/);
  assert.match(source, /Product update cache invalidation failed/);
});
