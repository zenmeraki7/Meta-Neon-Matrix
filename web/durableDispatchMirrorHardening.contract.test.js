import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(path, "utf8");

test("enqueue intents use scoped partial uniqueness and fenced claims", () => {
  const schema = read("web/prisma/schema.prisma");
  const service = read("web/services/operationEnqueueIntentService.js");
  const migration = read("web/prisma/migrations/20260801101000_enqueue_intent_partial_unique_concurrently/migration.sql");
  assert.match(schema, /dispatchScope\s+String/);
  assert.doesNotMatch(schema, /@@unique\(\[shop, dispatchDedupeKey\]/);
  assert.match(migration, /CREATE UNIQUE INDEX CONCURRENTLY/);
  assert.match(migration, /WHERE "dedupeKey" IS NOT NULL/);
  assert.match(service, /createMany\([\s\S]*skipDuplicates: true/);
  assert.match(service, /FOR UPDATE SKIP LOCKED/);
  assert.match(service, /"dispatchFencingToken" = intent\."dispatchFencingToken" \+ 1/);
  assert.match(service, /dispatchClaimToken: intent\.dispatchClaimToken/);
  assert.match(service, /jobId: intent\.id/);
});

test("outbox payloads are immutable and dispatch claims are fenced", () => {
  const schema = read("web/prisma/schema.prisma");
  const worker = read("web/workers/outboxDispatcherWorker.js");
  const helper = read("web/helpers/immutableOutboxEvent.js");
  assert.match(schema, /payloadHash\s+String/);
  assert.match(schema, /lockToken\s+String\?/);
  assert.match(schema, /fencingToken\s+BigInt/);
  assert.match(schema, /deadLetteredAt\s+DateTime\?/);
  assert.match(worker, /FOR UPDATE SKIP LOCKED/);
  assert.match(worker, /lockToken: event\.lockToken/);
  assert.match(worker, /fencingToken: event\.fencingToken/);
  assert.match(helper, /hashOutboxPayload/);
});

test("mirror activation is CAS fenced and database-enforced", () => {
  const repository = read("web/repositories/productSyncRepository.js");
  const triggerMigration = read("web/prisma/migrations/20260801102000_mirror_activation_invariants/migration.sql");
  const indexMigration = read("web/prisma/migrations/20260801103000_mirror_active_partial_unique_concurrently/migration.sql");
  assert.match(repository, /FOR UPDATE/);
  assert.match(repository, /expectedMirrorMutationVersion/);
  assert.match(repository, /mirrorResourceType: "PRODUCT_CATALOG"/);
  assert.match(repository, /queueRoutingKey: "MIRROR_CLEANUP"/);
  assert.match(triggerMigration, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(triggerMigration, /COLLECTION_CATALOG/);
  assert.match(indexMigration, /CREATE UNIQUE INDEX CONCURRENTLY "MirrorBatch_one_active_per_shop_resource_uq"/);
});

test("merchant relations and mirror rows carry tenant and source authority", () => {
  const schema = read("web/prisma/schema.prisma");
  assert.match(schema, /snapshotSet\s+TargetSnapshotSet\?[\s\S]*fields: \[shop, snapshotSetId\]/);
  assert.doesNotMatch(schema, /automaticProductRuleRunId\s+String\?\s+@unique/);
  assert.doesNotMatch(schema, /undoOperationId\s+String\s+@unique/);
  for (const model of ["VariantTombstone", "MetafieldTombstone", "InventoryItemTombstone", "CollectionTombstone"]) {
    assert.match(schema, new RegExp(`model ${model} \\{`));
  }
  assert.match(schema, /compareDigest\s+String\?/);
  assert.match(schema, /sourceEventOccurredAt\s+DateTime\?/);
});
