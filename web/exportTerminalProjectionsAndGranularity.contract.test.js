import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test("Schema defines TerminalProjection outbox and status enums including CANCELLED and PARTIAL", async () => {
  const schemaContent = fs.readFileSync(
    path.join(__dirname, "prisma/schema.prisma"),
    "utf8",
  );

  assert.ok(
    schemaContent.includes("model TerminalProjection"),
    "schema.prisma must define TerminalProjection model",
  );
  assert.ok(
    schemaContent.includes("TerminalProjection_shop_source_version_key"),
    "schema.prisma must define a tenant-scoped TerminalProjection source-version unique index",
  );
  assert.ok(
    schemaContent.includes("enum ScheduledExportRunStatus"),
    "schema.prisma must define ScheduledExportRunStatus enum",
  );
  assert.ok(
    schemaContent.includes("enum RecurringEditRunStatus"),
    "schema.prisma must define RecurringEditRunStatus enum",
  );
  assert.ok(
    schemaContent.includes("CANCELLED"),
    "schema.prisma status enums must include CANCELLED",
  );
  assert.ok(
    schemaContent.includes("PARTIAL"),
    "schema.prisma status enums must include PARTIAL",
  );
});

test("Recurring edit execution service defines createRunFinalizationIntent", async () => {
  const fileContent = fs.readFileSync(
    path.join(__dirname, "services/recurringEditExecutionService.js"),
    "utf8",
  );

  assert.ok(
    fileContent.includes("createRunFinalizationIntent"),
    "recurringEditExecutionService must define createRunFinalizationIntent",
  );
});

test("Bulk export worker branch snapshot page by targetGranularity and checks EXPORT_SNAPSHOT_DATA_MISSING", async () => {
  const fileContent = fs.readFileSync(
    path.join(__dirname, "Jobs/Workers/bulkExportWorker.js"),
    "utf8",
  );

  assert.ok(
    fileContent.includes("getFrozenTargetVariantIds"),
    "bulkExportWorker must call getFrozenTargetVariantIds for VARIANT granularity",
  );
  assert.ok(
    fileContent.includes("findVariantsForExport"),
    "bulkExportWorker must call findVariantsForExport for VARIANT granularity",
  );
  assert.ok(
    fileContent.includes("EXPORT_SNAPSHOT_DATA_MISSING"),
    "bulkExportWorker must throw EXPORT_SNAPSHOT_DATA_MISSING when frozen snapshot items are missing",
  );
});

test("Bulk export repository exports findVariantsForExport helper", async () => {
  const fileContent = fs.readFileSync(
    path.join(__dirname, "repositories/bulkExportExecutionRepository.js"),
    "utf8",
  );

  assert.ok(
    fileContent.includes("findVariantsForExport"),
    "bulkExportExecutionRepository must define findVariantsForExport",
  );
});
