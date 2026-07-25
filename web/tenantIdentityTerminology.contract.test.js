import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const forbiddenIdentifier = `shop${"Id"}`;
const ignoredDirectories = new Set([
  ".git",
  "generated",
  "node_modules",
  "migrations",
]);

function sourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(absolute));
    } else if (/\.(?:js|mjs|cjs|ts|tsx|prisma)$/.test(entry.name)) {
      files.push(absolute);
    }
  }
  return files;
}

test("application identifiers never use the ambiguous tenant name", () => {
  const violations = sourceFiles(root)
    .filter((file) => file !== path.join(root, "web", "tenantIdentityTerminology.contract.test.js"))
    .filter((file) => file !== path.join(root, "web", "scripts", "auditOperationalNaming.js"))
    .filter((file) => new RegExp(forbiddenIdentifier, "i").test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(root, file));

  assert.deepEqual(
    violations,
    [],
    "Use storeId for Store.id and shopDomain for a normalized myshopify.com domain",
  );
});

test("shop sync queue carries both tenant identities explicitly", () => {
  const queue = fs.readFileSync(path.join(root, "web", "Jobs", "Queues", "shopSyncJob.js"), "utf8");
  const worker = fs.readFileSync(path.join(root, "web", "Jobs", "Workers", "shopSyncWorker.js"), "utf8");

  assert.match(queue, /storeId/);
  assert.match(queue, /shopDomain/);
  assert.doesNotMatch(queue, /data\.shop\b/);
  assert.match(worker, /storeId: rawStoreId, shopDomain: rawShopDomain/);
  assert.match(worker, /where:\s*\{\s*id: storeId/);
  assert.match(worker, /store\.id === storeId/);
  assert.match(worker, /store\.shopUrl === shopDomain/);
  assert.match(worker, /STORE_IDENTITY_MISMATCH/);
});

test("canonical branded identity types and runtime boundary parsers exist", () => {
  const types = fs.readFileSync(path.join(root, "web", "types", "identity.ts"), "utf8");
  const queue = fs.readFileSync(path.join(root, "web", "Jobs", "Queues", "shopSyncJob.js"), "utf8");

  for (const name of ["StoreId", "ShopDomain", "MirrorBatchId", "ProductGid", "VariantGid"]) {
    assert.match(types, new RegExp(`export type ${name} = Brand<string, "${name}">`));
  }
  assert.match(queue, /requireShopDomain\(data\.shopDomain\)/);
  assert.match(queue, /requireStoreId\(data\.storeId\)/);
});

test("domain-owned Prisma models use shopDomain while preserving shop_id", () => {
  const schema = fs.readFileSync(path.join(root, "web", "prisma", "schema.prisma"), "utf8");
  const modelNames = [
    "VariantMetafield",
    "BulkEditSession",
    "BulkEditChange",
    "SyncCursor",
    "DeadLetterChange",
  ];

  for (const [index, modelName] of modelNames.entries()) {
    const start = schema.indexOf(`model ${modelName} {`);
    const nextStarts = modelNames
      .slice(index + 1)
      .map((name) => schema.indexOf(`model ${name} {`, start + 1))
      .filter((position) => position >= 0);
    const genericNext = schema.indexOf("\nmodel ", start + 1);
    const end = Math.min(
      ...[genericNext, ...nextStarts].filter((position) => position >= 0),
    );
    const model = schema.slice(start, Number.isFinite(end) ? end : schema.length);

    assert.ok(start >= 0, `${modelName} must exist`);
    assert.match(model, /shopDomain\s+String\s+@map\("shop_id"\)/);
    assert.doesNotMatch(model, new RegExp(`\\bshop${"Id"}\\b`, "i"));
  }
});

test("SyncHistory exposes mirrorBatchId while preserving syncBatchId storage", () => {
  const schema = fs.readFileSync(path.join(root, "web", "prisma", "schema.prisma"), "utf8");
  const start = schema.indexOf("model SyncHistory {");
  const end = schema.indexOf("\nmodel ", start + 1);
  const model = schema.slice(start, end);

  assert.match(model, /mirrorBatchId\s+String\?\s+@map\("syncBatchId"\)/);
  assert.doesNotMatch(model, /\bsyncHistoryId\s+String\?\s+@map\("syncBatchId"\)/);
});
