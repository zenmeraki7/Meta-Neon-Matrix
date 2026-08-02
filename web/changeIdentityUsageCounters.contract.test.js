import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

test("ChangeRecord has a stable field-attempt identity independent of Shopify batch IDs", () => {
  const schema = read("./prisma/schema.prisma");
  const identity = read("./services/changeRecordIdentityService.js");
  assert.match(schema, /changeIdentity\s+String\s+@db\.VarChar\(64\)/);
  assert.match(schema, /executionAttempt\s+Int\s+@default\(1\)/);
  assert.match(schema, /@@unique\(\[shop, editHistoryId, targetIdentity, fieldPath, executionAttempt\]/);
  assert.doesNotMatch(schema, /@@unique\(\[shop, editHistoryId, shopifySubmissionBatchId, targetIdentity, fieldPath\]/);
  assert.match(identity, /sha256/);
  assert.match(identity, /upsertAuthoritativeChangeRecord/);
});

test("migration expands field JSON, null-safely detects duplicates and validates counter constraints", () => {
  const migration = read("./prisma/migrations/20260801110000_change_identity_usage_and_counter_integrity/migration.sql");
  assert.match(migration, /jsonb_array_elements/);
  assert.match(migration, /IS NOT DISTINCT FROM/);
  assert.match(migration, /ChangeRecordIdentityDuplicate/);
  assert.match(migration, /VALIDATE CONSTRAINT "TargetSnapshotSet_execution_total_check"/);
  assert.match(migration, /ALTER COLUMN "runCount" TYPE BIGINT/g);
});

test("usage accounting models carry authority, operation, period and idempotency identity", () => {
  const schema = read("./prisma/schema.prisma");
  for (const model of ["UsagePeriod", "UsageReservation", "UsageLedgerEntry"]) {
    assert.match(schema, new RegExp(`model ${model} \\{`));
  }
  assert.match(schema, /@@unique\(\[shop, operationType, operationId, entitlementKey\]\)/);
  assert.match(schema, /billingAuthorityVersion\s+BigInt/);
  assert.match(schema, /reservedAmount\s+BigInt/);
  assert.match(schema, /consumedAmount\s+BigInt/);
  assert.match(schema, /releasedAmount\s+BigInt/);
});

test("reservation locks billing authority and settlement is ledger-idempotent", () => {
  const service = read("./services/usageLedgerService.js");
  const repository = read("./repositories/bulkEditCommandRepository.js");
  const command = read("./services/bulkEdit/BulkEditCommandService.js");
  assert.match(service, /FROM "Subscription"[\s\S]*FOR UPDATE/);
  assert.match(service, /BILLING_AUTHORITY_VERSION_MISMATCH/);
  assert.match(service, /usageLedgerEntry\.createMany/);
  assert.match(service, /skipDuplicates: true/);
  assert.match(repository, /reserveUsageInTransaction\([\s\S]*tx,/);
  assert.match(command, /consumeUsage\(/);
});

test("aggregate recovery derives projections from field and item rows", () => {
  const service = read("./services/counterProjectionService.js");
  const itemRepository = read("./repositories/bulkEditItemApplyRepository.js");
  assert.match(service, /FROM "ChangeRecord"/);
  assert.match(service, /FROM "UndoItem"/);
  assert.match(service, /refreshTargetSnapshotSetCounters/);
  assert.match(itemRepository, /COUNTER_INCREMENT_REQUIRES_ITEM_STATE_TRANSITION/);
});
