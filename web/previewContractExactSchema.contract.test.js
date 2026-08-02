import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (file) => fs.readFileSync(file, "utf8");
const schema = read("web/prisma/schema.prisma");
const migration = read("web/prisma/migrations/20260801150000_exact_preview_contract_and_dispatch_contract/migration.sql");
const concurrent = read("web/prisma/migrations/20260801151000_exact_partial_claim_indexes_concurrently/migration.sql");
const repository = read("web/repositories/previewContractRepository.js");

test("preview contracts are tenant-bound immutable lifecycle records", () => {
  assert.match(schema, /enum PreviewContractStatus \{[\s\S]*LEGACY_UNTRUSTED[\s\S]*\}/);
  const model = schema.match(/model PreviewContract \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(model, /stateVersion\s+Int\s+@default\(0\)/);
  assert.match(model, /fields: \[shop, snapshotSetId\], references: \[shop, id\], onDelete: Restrict/);
  assert.match(model, /@@unique\(\[shop, contractHash\]\)/);
  assert.match(model, /@@unique\(\[shop, snapshotSetId, revision\]\)/);
  assert.doesNotMatch(schema.match(/model TargetSnapshotSet \{[\s\S]*?\n\}/)?.[0] || "", /previewContractId\s+String/);
  assert.match(migration, /LEGACY_UNTRUSTED/);
  assert.match(migration, /PREVIEW_CONTRACT_AUTHORITY_IMMUTABLE/);
  assert.match(concurrent, /PreviewContract_shop_execution_nonnull_uq/);
  assert.match(concurrent, /WHERE "executionId" IS NOT NULL/);
});

test("preview approval and execution claims are compare-and-set", () => {
  assert.match(repository, /status: "READY_FOR_REVIEW"[\s\S]*stateVersion: Number\(expectedStateVersion\)[\s\S]*expiresAt: \{ gt: now \}[\s\S]*executionId: null/);
  assert.match(repository, /status: "APPROVED"[\s\S]*stateVersion: Number\(expectedStateVersion\)[\s\S]*executionId: null/);
  assert.match(repository, /status: "EXECUTION_CREATED"/);
  assert.match(repository, /createExecutionArtifacts\(\{[\s\S]*tx,[\s\S]*shop: canonicalShop,[\s\S]*previewContractId,[\s\S]*executionId,[\s\S]*idempotencyKeyHash/);
});

test("dispatch, target identity, usage and tenant-leading indexes use exact fields", () => {
  const intent = schema.match(/model OperationEnqueueIntent \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(intent, /dispatchLeaseExpiresAt\s+DateTime\?/);
  assert.match(intent, /dispatchClaimToken\s+String\?/);
  assert.match(intent, /dispatchFencingToken\s+BigInt\s+@default\(0\)/);
  assert.doesNotMatch(intent, /availableAt\s+DateTime/);
  assert.match(schema, /@@id\(\[shop, id\]\)[\s\S]*@@unique\(\[shop, snapshotSetId, targetKey, fieldPath\]\)/);
  assert.match(schema, /periodId\s+String[\s\S]*subscriptionVersion\s+BigInt[\s\S]*idempotencyKeyHash\s+String/);
  assert.match(migration, /TargetSnapshotItem_identity_ck/);
  assert.match(migration, /TargetSnapshotSet_counts_nonnegative_ck/);
  assert.match(concurrent, /OutboxEvent_claim_idx[\s\S]*"nextAttemptAt", "createdAt", "id"/);
});
