import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("schema.prisma defines stateVersion on EditHistory and ExportJob, and IdempotencyRecord model", () => {
  const schema = fs.readFileSync(new URL("./prisma/schema.prisma", import.meta.url), "utf8");
  assert.ok(schema.includes("stateVersion              Int                              @default(0)"), "EditHistory stateVersion missing");
  assert.ok(schema.includes("stateVersion             Int                     @default(0)"), "ExportJob stateVersion missing");
  assert.ok(schema.includes("model IdempotencyRecord {"), "IdempotencyRecord model missing");
  assert.ok(schema.includes("ownerToken   String?"), "IdempotencyRecord ownerToken missing");
  assert.ok(schema.includes("lockedUntil  DateTime?"), "IdempotencyRecord lockedUntil missing");
});

test("migration file contains stateVersion and IdempotencyRecord creation", () => {
  const migration = fs.readFileSync(
    new URL("./prisma/migrations/20260730100000_add_state_version_and_idempotency_record/migration.sql", import.meta.url),
    "utf8",
  );
  assert.ok(migration.includes('ALTER TABLE "EditHistory" ADD COLUMN IF NOT EXISTS "stateVersion"'), "EditHistory stateVersion migration missing");
  assert.ok(migration.includes('ALTER TABLE "ExportJob"   ADD COLUMN IF NOT EXISTS "stateVersion"'), "ExportJob stateVersion migration missing");
  assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS "IdempotencyRecord"'), "IdempotencyRecord table migration missing");
});

test("operationCancellationService.js uses stateVersion CAS and atomic transaction completion", () => {
  const src = fs.readFileSync(
    new URL("./services/operationCancellationService.js", import.meta.url),
    "utf8",
  );
  assert.ok(src.includes("stateVersion: history.stateVersion ?? 0"), "EditHistory cancellation stateVersion CAS missing");
  assert.ok(src.includes("stateVersion: job.stateVersion ?? 0"), "ExportJob cancellation stateVersion CAS missing");
  assert.ok(src.includes("STATE_TRANSITION_CONFLICT"), "STATE_TRANSITION_CONFLICT missing");
  assert.ok(src.includes("db.$transaction"), "Atomic transaction in cancellation service missing");
  assert.ok(src.includes("dbClient: tx"), "Passing tx to idempotencyStore.complete missing");
});

test("operationTransitionGuards.js increments stateVersion on guardedEditHistoryUpdate", () => {
  const src = fs.readFileSync(
    new URL("./services/operationTransitionGuards.js", import.meta.url),
    "utf8",
  );
  assert.ok(src.includes("stateVersion: { increment: 1 }"), "stateVersion increment missing in transition guard");
  assert.ok(src.includes("expectedStateVersion"), "expectedStateVersion param missing in transition guard");
});

test("bulkEditExecuteWorker.js exports and invokes assertWorkerOwnership", () => {
  const src = fs.readFileSync(
    new URL("./Jobs/Workers/bulkEditExecuteWorker.js", import.meta.url),
    "utf8",
  );
  assert.ok(src.includes("export async function assertWorkerOwnership"), "assertWorkerOwnership function missing");
  assert.ok(src.includes("EXECUTION_OWNERSHIP_LOST"), "EXECUTION_OWNERSHIP_LOST error code missing");
  assert.ok(src.includes("await assertWorkerOwnership("), "assertWorkerOwnership invocation missing");
});
