import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (relativePath) =>
  fs.readFileSync(path.join(process.cwd(), "web", relativePath), "utf8");

test("bulk apply exposes complete exclusive item-state counters", () => {
  const schema = read("prisma/schema.prisma");
  assert.match(schema, /eligibleItemCount\s+Int @default\(0\) @map\("totalCount"\)/);
  assert.match(schema, /pendingItemCount\s+Int @default\(0\)/);
  assert.match(schema, /applyingItemCount\s+Int @default\(0\)/);
  assert.match(schema, /appliedItemCount\s+Int @default\(0\) @map\("appliedCount"\)/);
  assert.match(schema, /failedItemCount\s+Int @default\(0\) @map\("failedCount"\)/);
});

test("bulk apply item transitions and reconciliation share one transaction", () => {
  const repository = read("lib/recomputeApplyStatus.server.ts");
  assert.match(repository, /prisma\.\$transaction\(async \(tx\) => \{/);
  assert.match(repository, /status: \{ in: allowedFrom/);
  assert.match(repository, /recomputeApplyRequestStatus\(\{ shop, applyRequestId, db: tx \}\)/);
  assert.match(repository, /count\("FAILED"\) \+ count\("FAILED_PERMANENT"\)/);
});

test("database checks reject negative, overflowing, and incomplete terminal counters", () => {
  const migration = read(
    "prisma/migrations/20260723101000_complete_undo_and_bulk_apply_counters/migration.sql",
  );
  assert.match(migration, /"pendingItemCount" \+ "applyingItemCount" \+ "appliedCount" \+ "failedCount"/);
  assert.match(migration, /"status" NOT IN \('COMPLETED', 'PARTIAL_FAILED', 'FAILED', 'CANCELLED'\)/);
  assert.match(migration, /"pendingItemCount" = 0 AND "applyingItemCount" = 0/);
});
