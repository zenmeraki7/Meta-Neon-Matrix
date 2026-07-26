import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(path, "utf8");

test("bounded operational workflows use Prisma enums and claim-shaped indexes", () => {
  const schema = read("web/prisma/schema.prisma");

  assert.match(schema, /status\s+TargetSnapshotSetStatus\s+@default\(FREEZING\)/);
  assert.match(schema, /status\s+TargetFreezeCommandStatus/);
  assert.match(schema, /stageStatus\s+OperationStageStatus/);
  assert.match(schema, /status\s+OperationEnqueueIntentStatus\s+@default\(PENDING\)/);
  assert.match(schema, /resolution\s+DeadLetterResolution\?/);
  assert.match(schema, /status\s+MirrorReconcileSignalStatus\s+@default\(PENDING\)/);
  assert.match(schema, /@@index\(\[shop, snapshotSetId, executionStatus\]\)/);
  assert.match(schema, /@@index\(\[shop, snapshotSetId, undoStatus\]\)/);
  assert.match(schema, /@@index\(\[status, createdAt, id\]\)/);
});

test("migration repairs aggregates before validating counter constraints", () => {
  const migration = read(
    "web/prisma/migrations/20260722105000_workflow_state_and_counter_integrity/migration.sql",
  );

  const snapshotRepair = migration.indexOf('UPDATE "TargetSnapshotSet" setrow');
  const snapshotCheck = migration.indexOf('ADD CONSTRAINT "TargetSnapshotSet_counter_bounds_check"');

  assert.ok(snapshotRepair >= 0 && snapshotRepair < snapshotCheck);
  assert.match(migration, /Store_sync_stage_projection_check/);
});

test("raw duplicated workflow states are no longer indexed", () => {
  const schema = read("web/prisma/schema.prisma");
  const editHistory = schema.match(/model EditHistory \{[\s\S]*?\n\}/)?.[0] || "";
  const webhookDelivery = schema.match(/model WebhookDelivery \{[\s\S]*?\n\}/)?.[0] || "";
  assert.doesNotMatch(editHistory, /map: "shop_status_type_recent"/);
  assert.doesNotMatch(editHistory, /@@index\(\[shop, executionState\]\)/);
  assert.doesNotMatch(webhookDelivery, /@@index\(\[status, createdAt\]\)/);
});

test("sync API and reconciliation decisions use the authoritative stage", () => {
  const service = read("web/services/syncStatusQueryService.js");
  const worker = read("web/Jobs/Workers/reconciliationWorker.js");

  assert.match(service, /const active = stage !== "IDLE"/);
  assert.match(service, /isProductSyncing: active/);
  assert.match(worker, /store\.syncProgressStage !== "IDLE"/);
  assert.doesNotMatch(worker, /store\.isProductSyncing/);
});
