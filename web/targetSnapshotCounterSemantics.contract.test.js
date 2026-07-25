import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (relativePath) =>
  fs.readFileSync(path.join(process.cwd(), "web", relativePath), "utf8");

test("target snapshot composition includes every supported target resource", () => {
  const schema = read("prisma/schema.prisma");
  assert.match(schema, /inventoryItemCount\s+Int @default\(0\)/);
  assert.match(schema, /metafieldCount\s+Int @default\(0\)/);

  const migration = read(
    "prisma/migrations/20260723100000_target_snapshot_verification_counters/migration.sql",
  );
  assert.match(
    migration,
    /"targetCount" = "productCount" \+ "variantCount" \+ "inventoryItemCount" \+ "metafieldCount"/,
  );
});

test("mutation and verification use independent state machines and counters", () => {
  const schema = read("prisma/schema.prisma");
  assert.match(schema, /mutationPendingCount\s+Int @default\(0\) @map\("pendingCount"\)/);
  assert.match(schema, /verificationPendingCount\s+Int @default\(0\)/);
  assert.match(schema, /verificationSucceededCount\s+Int @default\(0\) @map\("verifiedCount"\)/);
  assert.match(schema, /verificationFailedCount\s+Int @default\(0\)/);
  assert.match(schema, /verificationStatus\s+TargetSnapshotItemVerificationStatus\?/);
  assert.doesNotMatch(
    schema.match(/enum TargetSnapshotItemExecutionStatus \{[\s\S]*?\}/)?.[0] || "",
    /VERIFIED/,
  );
  assert.match(
    schema.match(/enum TargetSnapshotItemVerificationStatus \{[\s\S]*?\}/)?.[0] || "",
    /PENDING[\s\S]*SUCCEEDED[\s\S]*FAILED/,
  );
});

test("verification writes item results and refreshes parent summaries", () => {
  const service = read("services/bulkEdit/BulkEditVerificationService.js");
  assert.match(service, /verificationStatus: "PENDING"/);
  assert.match(service, /verificationStatus: "SUCCEEDED"/);
  assert.match(service, /verificationStatus: "FAILED"/);
  assert.match(service, /refreshTargetSnapshotSetCounters/);

  const repository = read("repositories/targetSnapshotSetRepository.js");
  assert.match(repository, /COUNT\(\*\) FILTER \(WHERE item\."verificationStatus" = 'FAILED'\)/);
  assert.match(repository, /"verificationFailedCount" = counts\."verificationFailedCount"/);
});

test("undo summaries cover every exclusive undo state", () => {
  const schema = read("prisma/schema.prisma");
  for (const field of [
    "undoNotRequiredCount",
    "undoPendingCount",
    "undoSubmittedCount",
    "undoSucceededCount",
    "undoFailedCount",
    "undoSkippedCount",
  ]) {
    assert.match(schema, new RegExp(`${field}\\s+Int @default\\(0\\)`));
  }

  const repository = read("repositories/targetSnapshotSetRepository.js");
  for (const state of ["NOT_REQUIRED", "PENDING", "SUBMITTED", "SUCCEEDED", "FAILED", "SKIPPED"]) {
    assert.match(repository, new RegExp(`item\\."undoStatus" = '${state}'`));
  }

  const migration = read(
    "prisma/migrations/20260723101000_complete_undo_and_bulk_apply_counters/migration.sql",
  );
  assert.match(
    migration,
    /"targetCount" = "undoNotRequiredCount" \+ "undoPendingCount" \+ "undoSubmittedCount"/,
  );
});

test("undo result transitions reconcile parent counters in the same transaction", () => {
  const service = read("services/undo/UndoResultIngestionService.js");
  assert.match(service, /db\.\$transaction\(async \(tx\) => \{/);
  assert.match(service, /undoStatus: \{ in: \["PENDING", "SUBMITTED"\] \}/);
  assert.match(service, /refreshTargetSnapshotSetCounters\(\{[\s\S]*?db: tx/);
});
