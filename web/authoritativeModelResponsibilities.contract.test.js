import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("Export history responsibility is owned by ExportJob only", () => {
  const schema = read("web/prisma/schema.prisma");
  assert.match(schema, /model\s+ExportJob\s*\{/);
  assert.doesNotMatch(schema, /model\s+ExportHistory\s*\{/);
});

test("Frozen targets responsibility is owned by TargetSnapshotSet and TargetSnapshotItem", () => {
  const schema = read("web/prisma/schema.prisma");
  assert.match(schema, /model\s+TargetSnapshotSet\s*\{/);
  assert.match(schema, /model\s+TargetSnapshotItem\s*\{/);
});

test("Tenant identity responsibility is owned by Store.shopUrl", () => {
  const schema = read("web/prisma/schema.prisma");
  assert.match(schema, /model\s+Store\s*\{/);
  assert.match(schema, /shopUrl\s+String\s+@unique/);
  assert.doesNotMatch(schema, /model\s+LegacyShop\s*\{/);
});

test("Queue delivery responsibility is owned by OperationEnqueueIntent", () => {
  const schema = read("web/prisma/schema.prisma");
  assert.match(schema, /model\s+OperationEnqueueIntent\s*\{/);
});

test("Domain events responsibility is owned by OutboxEvent", () => {
  const schema = read("web/prisma/schema.prisma");
  assert.match(schema, /model\s+OutboxEvent\s*\{/);
});

test("Worker ownership responsibility is owned by OperationLease", () => {
  const schema = read("web/prisma/schema.prisma");
  assert.match(schema, /model\s+OperationLease\s*\{/);
});

test("Idempotency responsibility is owned by OperationFingerprint or workflow-specific unique identities", () => {
  const schema = read("web/prisma/schema.prisma");
  assert.match(schema, /model\s+OperationFingerprint\s*\{/);
});

test("Authoritative model per responsibility rule is documented in docs and agent rules", () => {
  const identityDoc = read("web/docs/identity-lifecycle-terminology.md");
  const responsibilitiesDoc = read("docs/authoritative-model-responsibilities.md");
  const agentRules = read(".agents/AGENTS.md");

  for (const doc of [identityDoc, responsibilitiesDoc, agentRules]) {
    assert.match(doc, /One authoritative model per responsibility/i);
    assert.match(doc, /Export history/i);
    assert.match(doc, /ExportJob/);
    assert.match(doc, /TargetSnapshotSet/);
    assert.match(doc, /TargetSnapshotItem/);
    assert.match(doc, /Store\.shopUrl/);
    assert.match(doc, /OperationEnqueueIntent/);
    assert.match(doc, /OutboxEvent/);
    assert.match(doc, /OperationLease/);
    assert.match(doc, /OperationFingerprint/);
  }
});
