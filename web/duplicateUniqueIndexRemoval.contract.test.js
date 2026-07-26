import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (relativePath) =>
  fs.readFileSync(path.join(process.cwd(), "web", relativePath), "utf8");

function model(schema, name) {
  return schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] || "";
}

test("exact indexes duplicated by unique constraints are absent from Prisma", () => {
  const schema = read("prisma/schema.prisma");
  const conflictChunk = model(schema, "UndoOperationConflictChunk");
  const automaticRule = model(schema, "AutomaticProductRule");

  assert.match(conflictChunk, /@@unique\(\[shop, undoOperationId, chunkType, chunkIndex\]\)/);
  assert.doesNotMatch(conflictChunk, /@@index\(\[shop, undoOperationId, chunkType, chunkIndex\]\)/);

  assert.match(automaticRule, /@@unique\(\[shop, id\]\)/);
  assert.doesNotMatch(automaticRule, /@@index\(\[shop, id\]\)/);
});

test("migration drops only the two redundant ordinary indexes concurrently", () => {
  const migration = read(
    "prisma/migrations/20260726100000_remove_exact_duplicate_indexes/migration.sql",
  );

  assert.match(
    migration,
    /DROP INDEX CONCURRENTLY IF EXISTS[\s\S]*"UndoOperationConflictChunk_shop_undoOperationId_chunkType_c_idx"/,
  );
  assert.match(
    migration,
    /DROP INDEX CONCURRENTLY IF EXISTS[\s\S]*"AutomaticProductRule_shop_id_idx"/,
  );
  assert.equal((migration.match(/DROP INDEX/g) || []).length, 2);
});
