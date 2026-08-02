import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

test("typed scheduler state is narrow, fenced, revision-bound and tenant indexed", () => {
  const schema = read("./prisma/schema.prisma");
  for (const model of ["RecurringEditScheduleState", "ScheduledExportScheduleState"]) {
    assert.match(schema, new RegExp(`model ${model} \\{[\\s\\S]*definitionRevision\\s+Int[\\s\\S]*scheduleVersion\\s+Int[\\s\\S]*claimExpiresAt\\s+DateTime\\?[\\s\\S]*fencingToken\\s+BigInt[\\s\\S]*missedRunPolicy\\s+String`));
  }
  const indexes = read("./prisma/migrations/20260801121000_scheduler_indexes_concurrently/migration.sql");
  assert.match(indexes, /CREATE INDEX CONCURRENTLY IF NOT EXISTS "RecurringEditScheduleState_due_active_idx"[\s\S]*\("shop","nextRunAt","recurringEditId"\)[\s\S]*WHERE "disabledAt" IS NULL/);
  assert.match(indexes, /CREATE INDEX CONCURRENTLY IF NOT EXISTS "ScheduledExportScheduleState_due_active_idx"/);
});

test("scheduler claims use one SKIP LOCKED statement and fenced completion", () => {
  const repository = read("./repositories/scheduleStateRepository.js");
  assert.match(repository, /FOR UPDATE SKIP LOCKED/g);
  assert.match(repository, /"fencingToken"=state\."fencingToken" \+ 1/g);
  assert.match(repository, /definitionRevision: claim\.definitionRevision/);
  assert.match(repository, /scheduleVersion: claim\.scheduleVersion/);
  assert.match(repository, /fencingToken: claim\.fencingToken/);
});

test("definition mutations persist immutable revisions and invalidate old claims", () => {
  const revisions = read("./services/scheduleRevisionService.js");
  const recurringRepo = read("./repositories/recurringEditRepository.js");
  const exportRepo = read("./repositories/scheduledExportRepository.js");
  assert.match(revisions, /scheduleVersion: \{ increment: 1 \}/g);
  assert.match(revisions, /claimedAt: null, claimOwner: null, claimExpiresAt: null/);
  assert.match(recurringRepo, /persistRecurringEditRevision/);
  assert.match(exportRepo, /persistScheduledExportRevision/);
  assert.match(recurringRepo, /DIRECT_DEFINITION_SCHEDULER_CLAIM_FORBIDDEN/);
  assert.match(exportRepo, /DIRECT_DEFINITION_SCHEDULER_CLAIM_FORBIDDEN/);
});

test("new runs capture revision hashes and workers load revision snapshots", () => {
  const recurring = read("./services/recurringEditExecutionService.js");
  const scheduled = read("./services/scheduledExportExecutionService.js");
  for (const source of [recurring, scheduled]) {
    assert.match(source, /definitionRevision: revision\.revision/);
    assert.match(source, /configurationHash: revision\.configurationHash/);
    assert.match(source, /filterSnapshotHash: revision\.filterSnapshotHash/);
    assert.match(source, /schedulePolicySnapshotHash: revision\.schedulePolicySnapshotHash/);
    assert.match(source, /definitionSnapshot\.definitionSnapshot/);
  }
});

test("migration backfills only determinable revisions and quarantines ambiguity as legacy", () => {
  const migration = read("./prisma/migrations/20260801120000_schedule_state_and_immutable_revisions/migration.sql");
  assert.match(migration, /run\."createdAt">=definition\."updatedAt"/g);
  assert.match(migration, /"legacyRevisionUnknown"=true WHERE "definitionRevision" IS NULL/g);
  assert.match(migration, /revision_authority_check/g);
  assert.match(migration, /NOT VALID/g);
  assert.match(migration, /VALIDATE CONSTRAINT/g);
});
