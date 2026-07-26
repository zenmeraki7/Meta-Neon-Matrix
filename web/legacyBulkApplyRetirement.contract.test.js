import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, "web", relativePath), "utf8");

test("legacy bulk-apply models and enums are absent", () => {
  const schema = read("prisma/schema.prisma");
  for (const name of [
    "BulkApplyRequest",
    "BulkApplyItem",
    "ProductApplySnapshot",
    "BulkApplyRequestStatus",
    "BulkApplyItemStatus",
  ]) {
    assert.doesNotMatch(schema, new RegExp(`(?:model|enum) ${name} \\{`));
  }
});

test("legacy routers and queue are not mounted or present", () => {
  const app = read("app.js");
  assert.doesNotMatch(app, /bulkEditApplyRouter|bulkEditCancelRouter/);
  assert.equal(fs.existsSync(path.join(root, "web/routes/bulkEditApply.route.js")), false);
  assert.equal(fs.existsSync(path.join(root, "web/routes/bulkEditCancel.route.js")), false);
  assert.equal(fs.existsSync(path.join(root, "web/queues/applyQueue.js")), false);
  assert.equal(fs.existsSync(path.join(root, "web/workers/apply.worker.ts")), false);
});

test("canonical TargetSnapshotSet execution path remains mounted and bootstrapped", () => {
  const app = read("app.js");
  const routes = read("routes/productRoutes.js");
  const worker = read("worker.js");
  const executeWorker = read("Jobs/Workers/bulkEditExecuteWorker.js");

  assert.match(app, /app\.use\("\/api\/products", productRoutes\)/);
  assert.match(routes, /router\.post\([\s\S]*?"\/update"[\s\S]*?handleBulkEditProduct/);
  assert.match(worker, /\.\/Jobs\/Workers\/bulkEditExecuteWorker\.js/);
  assert.match(executeWorker, /getFrozenSnapshotSetForExecution/);
  assert.match(executeWorker, /snapshotSetId/);
});

test("retirement migration refuses to discard non-terminal legacy work", () => {
  const migration = read(
    "prisma/migrations/20260726102000_retire_legacy_bulk_apply_pipeline/migration.sql",
  );
  const guard = migration.indexOf("contains non-terminal work");
  const drop = migration.indexOf('DROP TABLE IF EXISTS "BulkApplyRequest"');
  assert.ok(guard >= 0 && drop > guard);
  assert.match(migration, /WHERE "status"::text IN \('QUEUED', 'RUNNING'\)/);
  assert.match(migration, /DROP TABLE IF EXISTS "ProductApplySnapshot"/);
  assert.match(migration, /DROP TYPE IF EXISTS "BulkApplyItemStatus"/);
});
