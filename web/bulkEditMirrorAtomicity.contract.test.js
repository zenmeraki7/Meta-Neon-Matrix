import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

const ingestion = read("web/services/bulkEdit/BulkEditResultIngestionService.js");
const mirror = read("web/services/bulkEdit/BulkEditMirrorApplyService.js");
const schema = read("web/prisma/schema.prisma");
const migration = read(
  "web/prisma/migrations/20260606170000_add_change_record_mirror_lifecycle/migration.sql",
);
const defaultFixMigration = read(
  "web/prisma/migrations/20260607123000_fix_change_record_mirror_pending_default/migration.sql",
);

test("crash after Shopify result ingestion resumes persisted MIRROR_PENDING rows", () => {
  assert.match(schema, /mirrorStatus\s+String\s+@default\("MIRROR_PENDING"\)/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "mirrorStatus"/);
  assert.match(migration, /DEFAULT 'MIRROR_PENDING'/);
  assert.match(defaultFixMigration, /ALTER COLUMN "mirrorStatus" SET DEFAULT 'MIRROR_PENDING'/);
  assert.match(defaultFixMigration, /"status" IN \('SUCCESS', 'VERIFIED', 'APPLIED'\)/);
  assert.match(defaultFixMigration, /"mirrorAppliedAt" IS NULL/);
  assert.match(ingestion, /WHEN \$\{status\} = 'SUCCESS' THEN 'MIRROR_PENDING'/);
  assert.match(ingestion, /rowsIngestedAt/);
  assert.match(mirror, /mirrorStatus: "MIRROR_PENDING"/);
  assert.match(mirror, /MIRROR_ELIGIBLE_CHANGE_RECORD_STATUSES = \["SUCCESS", "VERIFIED", "APPLIED"\]/);
});

test("mirror rows and ledger finalization share one Postgres transaction", () => {
  assert.match(mirror, /const pageResult = await db\.\$transaction\(async \(tx\) =>/);
  assert.match(mirror, /tx\.product\.updateMany/);
  assert.match(mirror, /tx\.variant\.updateMany/);
  assert.match(mirror, /client: tx,[\s\S]*mirrorStatus: "MIRROR_APPLIED"/);
});

test("already-current mirror rows skip writes and still become MIRROR_APPLIED", () => {
  assert.match(mirror, /function buildPatchMismatchWhere/);
  assert.match(mirror, /\.\.\.buildPatchMismatchWhere\(group\.patch\)/);
  assert.match(mirror, /mirrorStatus: "MIRROR_APPLIED"/);
});

test("undo mirror finalization is retry-safe after mirror apply but before source undo completion", () => {
  assert.match(mirror, /mirrorStatus: "MIRROR_PENDING"/);
  assert.match(mirror, /status: \{ notIn: \["completed", "partial"\] \}/);
  assert.match(mirror, /if \(finalized\.count !== 1\)/);
  assert.match(mirror, /String\(existing\?\.status \|\| ""\)\.toLowerCase\(\) !== String\(finalStatus\)\.toLowerCase\(\)/);
});

test("job finalization is gated by zero pending rows inside a transaction", () => {
  assert.match(mirror, /await db\.\$transaction\(async \(tx\) =>[\s\S]*mirrorStatus: "MIRROR_PENDING"/);
  assert.match(mirror, /MIRROR_APPLY_PENDING_ROWS_REMAIN/);
  assert.match(mirror, /tx\.editHistory\.updateMany/);
  assert.doesNotMatch(
    ingestion.slice(
      ingestion.indexOf("const completedUpdate"),
      ingestion.indexOf("const mirrorApplyResult"),
    ),
    /status:\s*["']completed["']/,
  );
});
