import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(path, "utf8");

test("bounded operational workflows use Prisma enums and claim-shaped indexes", () => {
  const schema = read("web/prisma/schema.prisma");

  assert.match(schema, /status\s+BulkApplyRequestStatus\s+@default\(QUEUED\)/);
  assert.match(schema, /status\s+BulkApplyItemStatus\s+@default\(PENDING\)/);
  assert.match(schema, /status\s+TargetFreezeCommandStatus/);
  assert.match(schema, /stageStatus\s+OperationStageStatus/);
  assert.match(schema, /status\s+OperationEnqueueIntentStatus\s+@default\(PENDING\)/);
  assert.match(schema, /resolution\s+DeadLetterResolution\?/);
  assert.match(schema, /status\s+MirrorReconcileSignalStatus\s+@default\(PENDING\)/);
  assert.match(schema, /@@index\(\[shop, status, createdAt, id\]\)/);
  assert.match(schema, /@@index\(\[status, createdAt, id\]\)/);
});

test("bulk apply items have tenant-scoped request ownership", () => {
  const schema = read("web/prisma/schema.prisma");
  const route = read("web/routes/bulkEditApply.route.js");
  const worker = read("web/workers/apply.worker.ts");
  const transitions = read("web/lib/recomputeApplyStatus.server.ts");

  assert.match(
    schema,
    /request\s+BulkApplyRequest\s+@relation\(fields: \[shop, requestId\], references: \[shop, id\], onDelete: Cascade\)/,
  );
  assert.match(route, /requestId: applyRequest\.id/);
  assert.match(transitions, /shop,[\s\S]*requestId: applyRequestId/);
  assert.match(transitions, /status: \{ in: allowedFrom \}/);
  assert.match(transitions, /recomputeApplyRequestStatus\(\{ shop, applyRequestId, db: tx \}\)/);
  assert.match(worker, /requestId: applyRequestId,[\s\S]*status: \{ in: \["PENDING", "FAILED"\] \}/);
});

test("migration repairs aggregates before validating counter constraints", () => {
  const migration = read(
    "web/prisma/migrations/20260722105000_workflow_state_and_counter_integrity/migration.sql",
  );

  const bulkRepair = migration.indexOf('UPDATE "BulkApplyRequest" request');
  const bulkCheck = migration.indexOf('ADD CONSTRAINT "BulkApplyRequest_counter_bounds_check"');
  const snapshotRepair = migration.indexOf('UPDATE "TargetSnapshotSet" setrow');
  const snapshotCheck = migration.indexOf('ADD CONSTRAINT "TargetSnapshotSet_counter_bounds_check"');

  assert.ok(bulkRepair >= 0 && bulkRepair < bulkCheck);
  assert.ok(snapshotRepair >= 0 && snapshotRepair < snapshotCheck);
  assert.match(migration, /BulkApplyItem_shop_requestId_fkey/);
  assert.match(migration, /ON DELETE CASCADE ON UPDATE CASCADE NOT VALID/);
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
