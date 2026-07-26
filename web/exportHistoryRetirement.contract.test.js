import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("ExportJob is the sole export execution and history model", () => {
  const schema = read("web/prisma/schema.prisma");
  const service = read("web/services/productService/productExportService.js");
  const scheduled = read("web/services/scheduledExportExecutionService.js");

  assert.doesNotMatch(schema, /model\s+ExportHistory\s*\{/);
  assert.match(schema, /model\s+ExportJob\s*\{/);
  assert.match(service, /db\.exportJob\.findMany/);
  assert.match(service, /db\.exportJob\.findFirst/);
  assert.doesNotMatch(scheduled, /\.exportHistory\b|ExportHistory/);
});

test("retirement migration drops only the obsolete export projection", () => {
  const migration = read(
    "web/prisma/migrations/20260726105000_retire_export_history_projection/migration.sql",
  );
  assert.match(migration, /DROP TABLE IF EXISTS "ExportHistory"/);
  assert.doesNotMatch(migration, /DROP TABLE(?: IF EXISTS)? "ExportJob"/);
  assert.doesNotMatch(migration, /DROP TABLE(?: IF EXISTS)? "ScheduledExportRun"/);
});
