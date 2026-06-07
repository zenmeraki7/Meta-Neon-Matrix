import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  DATA_RETENTION_POLICY_BY_MODEL,
  TENANT_MODELS_REQUIRING_DELETION,
  assertRetentionPolicyComplete,
} from "./services/dataRetentionPolicy.js";
import {
  SHOP_DATA_DELETION_STEPS,
  assertShopDeletionRegistryComplete,
} from "./services/shopDataDeletionService.js";

const schema = fs.readFileSync(
  path.join(process.cwd(), "web/prisma/schema.prisma"),
  "utf8",
);

function tenantModelsFromSchema() {
  const models = [];
  const modelPattern = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  for (const match of schema.matchAll(modelPattern)) {
    const [, model, body] = match;
    if (/^\s+(shop|shopId|shopUrl|shopifyDomain)\s+String(?:\?|\s)/m.test(body)) {
      models.push(model);
    }
  }
  return models.sort();
}

test("every merchant-owned schema model has policy and deletion coverage", () => {
  assert.equal(assertRetentionPolicyComplete(), true);
  assert.equal(assertShopDeletionRegistryComplete(), true);

  const schemaModels = tenantModelsFromSchema();
  const policyModels = Object.keys(DATA_RETENTION_POLICY_BY_MODEL).sort();
  const deletionModels = SHOP_DATA_DELETION_STEPS.map(({ model }) => model).sort();
  const requiredModels = [...TENANT_MODELS_REQUIRING_DELETION].sort();

  assert.deepEqual(policyModels, schemaModels);
  assert.deepEqual(deletionModels, schemaModels);
  assert.deepEqual(requiredModels, schemaModels);
});

test("every retention declaration answers purpose, duration, trigger, and dependency", () => {
  for (const [model, policy] of Object.entries(DATA_RETENTION_POLICY_BY_MODEL)) {
    assert.ok(policy.purpose, `${model} is missing purpose`);
    assert.ok(policy.retention, `${model} is missing retention`);
    assert.ok(policy.trigger, `${model} is missing deletion trigger`);
    assert.ok(policy.dependencies, `${model} is missing dependencies`);
  }
});

test("shop deletion orders restrictive relation children before parents", () => {
  const order = new Map(
    SHOP_DATA_DELETION_STEPS.map(({ model }, index) => [model, index]),
  );
  const modelPattern = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  for (const match of schema.matchAll(modelPattern)) {
    const [, child, body] = match;
    if (!order.has(child)) continue;
    const relationPattern = /^\s+\w+\s+(\w+)\??\s+@relation\(([^)]*)\)/gm;
    for (const relation of body.matchAll(relationPattern)) {
      const [, parent, options] = relation;
      if (
        child === parent
        || !order.has(parent)
        || !/fields:\s*\[/.test(options)
        || /onDelete:\s*(Cascade|SetNull)/.test(options)
      ) {
        continue;
      }
      assert.ok(
        order.get(child) < order.get(parent),
        `${child} must be deleted before restrictive parent ${parent}`,
      );
    }
  }
});

test("shop/redact and uninstall use the shared exhaustive deletion service", () => {
  const privacy = fs.readFileSync(path.join(process.cwd(), "web/privacy.js"), "utf8");
  const uninstall = fs.readFileSync(
    path.join(process.cwd(), "web/Jobs/Workers/appUninstallWorker.js"),
    "utf8",
  );
  assert.match(privacy, /SHOP_REDACT:[\s\S]*deleteAllShopData/);
  assert.match(uninstall, /await deleteAllShopData\(shop\)/);
});

test("nightly retention worker is scheduled and loaded", () => {
  const installation = fs.readFileSync(
    path.join(process.cwd(), "web/Jobs/Workers/appInstallationWorker.js"),
    "utf8",
  );
  const workerManifest = fs.readFileSync(path.join(process.cwd(), "web/worker.js"), "utf8");
  const queue = fs.readFileSync(
    path.join(process.cwd(), "web/queues/adapters/dataRetentionQueueAdapter.js"),
    "utf8",
  );
  assert.match(installation, /enqueueDataRetentionPurgeSchedule\(\{ shop \}\)/);
  assert.match(workerManifest, /dataRetentionPurgeWorker\.js/);
  assert.match(queue, /0 0 \* \* \*/);
});
