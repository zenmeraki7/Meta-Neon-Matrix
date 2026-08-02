import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("child models use composite foreign keys containing shop and parentId", () => {
  const schema = read("web/prisma/schema.prisma");

  const compositeRelations = [
    { child: "UndoOperation", parent: "EditHistory", fields: "shop, sourceEditHistoryId", references: "shop, id" },
    { child: "UndoCommand", parent: "UndoOperation", fields: "shop, undoOperationId", references: "shop, id" },
    { child: "BulkEditRecoveryAudit", parent: "EditHistory", fields: "shop, historyId", references: "shop, id" },
    { child: "EditHistoryIngestionCheckpoint", parent: "EditHistory", fields: "shop, historyId", references: "shop, id" },
    { child: "RecurringEditRun", parent: "RecurringEdit", fields: "shop, recurringEditId", references: "shop, id" },
    { child: "AutomaticProductRuleRevision", parent: "AutomaticProductRule", fields: "shop, automaticProductRuleId", references: "shop, id" },
    { child: "AutomaticProductRuleScheduleState", parent: "AutomaticProductRule", fields: "shop, automaticProductRuleId", references: "shop, id" },
    { child: "AutomaticProductRuleRun", parent: "AutomaticProductRule", fields: "shop, automaticProductRuleId", references: "shop, id" },
    { child: "ScheduledExportRun", parent: "ScheduledExport", fields: "shop, scheduledExportId", references: "shop, id" },
    { child: "ExportJobCheckpoint", parent: "ExportJob", fields: "shop, exportJobId", references: "shop, id" },
    { child: "ChangeRecord", parent: "EditHistory", fields: "shop, editHistoryId", references: "shop, id" },
  ];

  for (const rel of compositeRelations) {
    const childMatch = schema.match(new RegExp(`model ${rel.child} \\{[\\s\\S]*?\\n\\}`));
    assert.ok(childMatch, `Child model ${rel.child} must exist`);
    const childBody = childMatch[0];
    assert.match(
      childBody,
      new RegExp(`fields:\\s*\\[${rel.fields.replace(/,\s*/g, ",\\s*")}\\]`),
      `${rel.child} must use composite fields [${rel.fields}]`,
    );
    assert.match(
      childBody,
      new RegExp(`references:\\s*\\[${rel.references.replace(/,\s*/g, ",\\s*")}\\]`),
      `${rel.child} must reference composite keys [${rel.references}] on ${rel.parent}`,
    );
  }
});

test("indexes match actual query shapes with shop tie-breaker ordering", () => {
  const schema = read("web/prisma/schema.prisma");

  assert.match(schema, /@@index\(\[shop,\s*statusNormalized,\s*updatedAt,\s*id\]\)/);
  assert.match(schema, /@@index\(\[shop,\s*createdAt,\s*id\]\)/);
  assert.match(schema, /@@index\(\[shop,\s*mirrorBatchId,\s*updatedAt,\s*id\]\)/);
});

test("schema contains no ordinary indexes duplicated by unique constraints or primary keys", () => {
  const schema = read("web/prisma/schema.prisma");

  const modelsToAudit = ["EditHistory", "UndoOperation", "ExportJob", "SpreadsheetFile", "Location"];

  for (const name of modelsToAudit) {
    const modelMatch = schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`));
    if (modelMatch) {
      const body = modelMatch[0];
      if (/@@unique\(\[shop,\s*id\]\)/.test(body) || /@@id\(\[shop,\s*id\]\)/.test(body)) {
        assert.doesNotMatch(
          body,
          /@@index\(\[shop,\s*id\]\)/,
          `Model ${name} must not contain redundant @@index([shop, id]) duplicating unique constraint`,
        );
      }
    }
  }
});

test("OperationEnqueueIntent includes both tenant-scoped and global worker claim indexes", () => {
  const schema = read("web/prisma/schema.prisma");
  const intentMatch = schema.match(/model OperationEnqueueIntent \{[\s\S]*?\n\}/);
  assert.ok(intentMatch, "OperationEnqueueIntent model must exist");
  const body = intentMatch[0];

  // Tenant-scoped read index
  assert.match(body, /@@index\(\[shop,\s*status,\s*nextAttemptAt,\s*id\]\)/);
  // Global worker claim queue index
  assert.match(body, /@@index\(\[status,\s*nextAttemptAt,\s*id\]\)/);
});

test("AutomaticProductRuleScheduleState implements narrow scheduler claim pattern", () => {
  const schema = read("web/prisma/schema.prisma");
  const scheduleMatch = schema.match(/model AutomaticProductRuleScheduleState \{[\s\S]*?\n\}/);
  assert.ok(scheduleMatch, "AutomaticProductRuleScheduleState model must exist");
  const body = scheduleMatch[0];

  assert.match(body, /nextRunAt\s+DateTime\?/);
  assert.match(body, /claimedAt\s+DateTime\?/);
  assert.match(body, /claimOwner\s+String\?/);
  assert.match(body, /fencingToken\s+BigInt/);
  assert.match(body, /disabledAt\s+DateTime\?/);
});

test("immutable command models are separated from mutable execution state models", () => {
  const schema = read("web/prisma/schema.prisma");

  // Freeze command vs set
  assert.match(schema, /model TargetFreezeCommand\s*\{/);
  assert.match(schema, /model TargetSnapshotSet\s*\{/);

  // Undo command vs operation
  assert.match(schema, /model UndoCommand\s*\{/);
  assert.match(schema, /model UndoOperation\s*\{/);

  // Rule revision vs run
  assert.match(schema, /model AutomaticProductRuleRevision\s*\{/);
  assert.match(schema, /model AutomaticProductRuleRun\s*\{/);
});

test("active workflow state uses normalized enums across models", () => {
  const schema = read("web/prisma/schema.prisma");

  assert.match(schema, /statusNormalized\s+ExportJobStatus/);
  assert.match(schema, /executionStateNormalized\s+ExportJobExecutionState/);
  assert.match(schema, /statusNormalized\s+EditHistoryStatus/);
  assert.match(schema, /executionStateNormalized\s+EditHistoryExecutionState/);
  assert.match(schema, /statusNormalized\s+OutboxEventStatus/);
  assert.match(schema, /installationStatus\s+StoreInstallationStatus/);
  assert.match(schema, /status\s+TargetSnapshotSetStatus/);
});

test("mirror batch activation relies on immutable batches and atomic Store pointers", () => {
  const schema = read("web/prisma/schema.prisma");
  const storeBlock = schema.match(/model Store \{[\s\S]*?\n\}/)?.[0] || "";
  const batchBlock = schema.match(/model MirrorBatch \{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(storeBlock, /currentProductMirrorBatchId/);
  assert.match(storeBlock, /currentCollectionMirrorBatchId/);
  assert.match(batchBlock, /expectedPreviousActiveBatchId/);
  assert.match(batchBlock, /replayStartSequence/);
  assert.match(batchBlock, /replayFinalizedThroughSequence/);
});

test("all thirteen architectural principles are documented in project rules and docs", () => {
  const identityDoc = read("web/docs/identity-lifecycle-terminology.md");
  const responsibilitiesDoc = read("docs/authoritative-model-responsibilities.md");
  const agentRules = read(".agents/AGENTS.md");

  for (const doc of [identityDoc, responsibilitiesDoc, agentRules]) {
    assert.match(doc, /One Authoritative Model per Responsibility/i);
    assert.match(doc, /Shop-scoped keys everywhere/i);
    assert.match(doc, /Composite foreign keys for tenant isolation/i);
    assert.match(doc, /Index actual query shapes/i);
    assert.match(doc, /Remove indexes duplicated by constraints/i);
    assert.match(doc, /Put shop first only for tenant queries/i);
    assert.match(doc, /Narrow scheduler/i);
    assert.match(doc, /Separate immutable commands from mutable execution state/i);
    assert.match(doc, /Use normalized enums for active workflow state/i);
    assert.match(doc, /Keep mirror batches immutable/i);
    assert.match(doc, /state-transition protection/i);
    assert.match(doc, /Enforce snapshot immutability/i);
    assert.match(doc, /Measure before removing/i);
  }
});
