import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("merchant-owned Prisma models include shop or shopDomain tenant discriminator", () => {
  const schema = read("web/prisma/schema.prisma");

  const merchantModels = [
    "EditHistory",
    "UndoOperation",
    "ExportJob",
    "ScheduledExport",
    "RecurringEdit",
    "AutomaticProductRule",
    "OperationEnqueueIntent",
    "OutboxEvent",
    "ProductSyncCommand",
    "OperationLease",
    "OperationStageProgress",
    "TargetSnapshotSet",
    "TargetSnapshotItem",
    "ProductCodeSnippet",
    "ChangeRecord",
    "BulkSubmission",
    "SpreadsheetFile",
  ];

  for (const modelName of merchantModels) {
    const modelMatch = schema.match(new RegExp(`model ${modelName} \\{[\\s\\S]*?\\n\\}`));
    assert.ok(modelMatch, `Model ${modelName} must exist in schema.prisma`);
    const modelBody = modelMatch[0];
    const hasShop = /\b(shop|shopDomain)\s+String\b/.test(modelBody);
    assert.ok(hasShop, `Model ${modelName} must include shop or shopDomain field`);
  }
});

test("merchant-owned unique indexes use shop-scoped compound keys", () => {
  const schema = read("web/prisma/schema.prisma");

  assert.match(schema, /@@unique\(\[shop,\s*executionIdentity\]\)/);
  assert.match(schema, /@@unique\(\[shop,\s*snapshotSetId,\s*targetKey\]\)/);
  assert.match(schema, /@@unique\(\[shop,\s*id\]\)/);
  assert.match(schema, /@@unique\(\[shop,\s*type,\s*idempotencyKey\]\)/);
  assert.match(schema, /@@unique\(\[shop,\s*aggregateType,\s*aggregateId,\s*eventType\]\)/);

  // Reject weak tenant contracts lacking shop
  assert.doesNotMatch(schema, /@@unique\(\[snapshotSetId,\s*targetKey\]\)/);
});

test("merchant-owned indexes enforce shop compound index prefixes", () => {
  const schema = read("web/prisma/schema.prisma");

  assert.match(schema, /@@index\(\[shop,\s*statusNormalized/);
  assert.match(schema, /@@index\(\[shop,\s*createdAt/);
  assert.match(schema, /@@index\(\[shop,\s*snapshotSetId,\s*executionStatus\]\)/);
  assert.match(schema, /@@index\(\[shop,\s*status,\s*createdAt\]\)/);
});

test("merchant-owned repositories and services never fetch using id alone", () => {
  const scheduledExportRepo = read("web/repositories/scheduledExportRepository.js");
  const recurringEditRepo = read("web/repositories/recurringEditRepository.js");
  const exportService = read("web/services/productService/productExportService.js");

  assert.match(scheduledExportRepo, /findByIdForShop/);
  assert.match(scheduledExportRepo, /where:\s*\{[\s\S]*?\bid\b[\s\S]*?\bshop\b/);

  assert.match(recurringEditRepo, /findByIdForShop/);
  assert.match(recurringEditRepo, /where:\s*\{[\s\S]*?\bid\b[\s\S]*?\bshop\b/);

  assert.match(exportService, /shop:\s*this\.session\.shop/);
  assert.doesNotMatch(exportService, /findUnique\(\{\s*where:\s*\{\s*id:\s*jobId\s*\}\s*\}\)/);
});

test("Shop-scoped keys everywhere rule is documented across docs and agent rules", () => {
  const identityDoc = read("web/docs/identity-lifecycle-terminology.md");
  const responsibilitiesDoc = read("docs/authoritative-model-responsibilities.md");
  const agentRules = read(".agents/AGENTS.md");

  for (const doc of [identityDoc, responsibilitiesDoc, agentRules]) {
    assert.match(doc, /Shop-scoped keys everywhere/i);
    assert.match(doc, /@@unique\(\[shop, executionIdentity\]\)/);
    assert.match(doc, /@@index\(\[shop, status, updatedAt\]\)/);
    assert.match(doc, /@@unique\(\[shop, snapshotSetId, targetKey\]\)/);
  }
});
