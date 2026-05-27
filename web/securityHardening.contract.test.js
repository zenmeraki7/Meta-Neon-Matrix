import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (p) => fs.readFileSync(path.resolve(p), "utf8");

test("admin recovery route enforces sensitive action guard + recovery scope", () => {
  const routes = read("web/routes/adminRoutes.js");
  assert.ok(routes.includes("adminSensitiveActionGuard"));
  assert.ok(routes.includes("requireAdminRecoveryScope"));
});

test("webhook delivery schema includes causal chain fields", () => {
  const schema = read("web/prisma/schema.prisma");
  assert.ok(schema.includes("firstWebhookId"));
  assert.ok(schema.includes("lastWebhookId"));
  assert.ok(schema.includes("causalChainId"));
});

test("unresolved webhook persistence stores causal trace ids", () => {
  const worker = read("web/Jobs/Workers/bulkOperationMutationWorker.js");
  assert.ok(worker.includes("buildCausalChainId"));
  assert.ok(worker.includes("firstWebhookId"));
  assert.ok(worker.includes("lastWebhookId"));
});

test("bulk edit controller no longer returns raw 500 body", () => {
  const src = read("web/controllers/productBulkEditController.js");
  assert.ok(src.includes("buildPublicApiErrorResponse"));
  assert.ok(!src.includes("Bulk edit failed - no result returned."));
});
