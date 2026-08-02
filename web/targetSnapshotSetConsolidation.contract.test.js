import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "prisma", ".git"].includes(entry.name)) return [];
      return walk(fullPath);
    }
    return /\.(?:js|ts)$/.test(entry.name) ? [fullPath] : [];
  });
}

test("only the set-and-item target snapshot schema remains", () => {
  const schema = read("web/prisma/schema.prisma");
  assert.doesNotMatch(schema, /model\s+TargetSnapshot\s*\{/);
  assert.match(schema, /model\s+TargetSnapshotSet\s*\{/);
  assert.match(schema, /model\s+TargetSnapshotItem\s*\{/);
  assert.match(schema, /ordinal\s+Int/);
  assert.match(schema, /@@unique\(\[shop, snapshotSetId, targetKey, fieldPath\]\)/);
  assert.doesNotMatch(schema, /@@unique\(\[snapshotSetId, targetKey\]\)/);
});

test("snapshot item uniqueness is explicitly tenant-scoped", () => {
  const migration = read(
    "web/prisma/migrations/20260726104000_tenant_scope_snapshot_item_identity/migration.sql",
  );
  const createTenantKey = migration.indexOf(
    '"TargetSnapshotItem_shop_snapshotSetId_targetKey_key"',
  );
  const dropOldKey = migration.indexOf(
    '"TargetSnapshotItem_snapshotSetId_targetKey_key"',
  );
  assert.ok(createTenantKey >= 0);
  assert.ok(dropOldKey > createTenantKey);
  assert.match(
    migration,
    /ON "TargetSnapshotItem" \("shop", "snapshotSetId", "targetKey"\)/,
  );
});

test("runtime code does not use the retired standalone Prisma delegate", () => {
  const offenders = walk(path.join(root, "web"))
    .filter((file) => file !== import.meta.filename)
    .filter((file) => /\.(?:targetSnapshot)\b/.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(root, file));
  assert.deepEqual(offenders, []);
});

test("all scheduled workflow families freeze through canonical set items", () => {
  const engine = read("web/services/targeting/TargetingEngineService.js");
  const scheduledExport = read("web/services/scheduledExportExecutionService.js");
  const bulkFreeze = read("web/services/bulkEdit/BulkEditTargetFreezeService.js");
  const automaticRule = read("web/services/automaticProductRuleExecutionService.js");

  assert.match(engine, /appendSnapshotItems/);
  assert.match(scheduledExport, /resolveAndFreezeExportTargets/);
  assert.match(bulkFreeze, /resolveAndFreezeScheduledTargets/);
  assert.match(bulkFreeze, /resolveAndFreezeRecurringRunTargets/);
  assert.match(automaticRule, /freezeExplicitTargetSet/);
});

test("migration verifies complete backfill before dropping only the old table", () => {
  const migration = read(
    "web/prisma/migrations/20260726103000_consolidate_target_snapshot_sets/migration.sql",
  );
  const verification = migration.indexOf("Standalone target snapshot backfill is incomplete");
  const drop = migration.indexOf('DROP TABLE "TargetSnapshot"');
  assert.ok(verification >= 0);
  assert.ok(drop > verification);
  assert.doesNotMatch(migration, /DROP TABLE "TargetSnapshot(?:Set|Item)"/);
});
