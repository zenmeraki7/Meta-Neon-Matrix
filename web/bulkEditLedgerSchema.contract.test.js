import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("bulk edit ledger schema, migration, and runtime SQL share the canonical contract", () => {
  const schema = read("web/prisma/schema.prisma");
  const migration = read(
    "web/prisma/migrations/20260606150000_canonical_bulk_edit_ledger/migration.sql",
  );
  const ledger = read("web/db/bulkEditChanges.js");
  const sessions = read("web/db/bulkEditSessions.js");
  const commitRepository = read("web/repositories/sessionCommitRepository.js");

  for (const source of [schema, migration]) {
    assert.match(source, /session_id/);
    assert.match(source, /shop_id/);
    assert.match(source, /variant_id/);
    assert.match(source, /shopify_owner_id/);
    assert.match(source, /field_name/);
    assert.match(source, /old_value/);
    assert.match(source, /new_value/);
    assert.match(source, /applied_at/);
    assert.match(source, /attempt_count/);
    assert.match(source, /status/);
  }

  assert.match(schema, /id\s+String\s+@id @default\(uuid\(\)\) @db\.Uuid/);
  assert.match(schema, /sessionId\s+String\s+@map\("session_id"\) @db\.Uuid/);
  assert.match(migration, /"id" UUID NOT NULL DEFAULT gen_random_uuid\(\)/);
  assert.match(migration, /"session_id" UUID NOT NULL/);

  for (const source of [ledger, sessions, commitRepository]) {
    assert.match(source, /::uuid/);
  }
  assert.doesNotMatch(ledger, /vm\.definition_id/);
  assert.doesNotMatch(schema, /variantMetafieldId/);
});
