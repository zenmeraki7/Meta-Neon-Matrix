import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (file) => fs.readFileSync(path.resolve(file), "utf8");

test("Prisma client enforces model and raw-SQL tenant guards", () => {
  const database = read("web/config/database.js");
  const guard = read("web/config/tenantScopeGuard.js");
  assert.ok(database.includes("assertTenantScopedRawPrismaArgs(operation, args)"));
  assert.ok(database.includes("enforceTenantScopedPrismaArgs(model, operation, args)"));
  assert.ok(guard.includes("TENANT_SCOPE_REQUIRED:RAW."));
  assert.ok(guard.includes("TENANT_SCOPE_REQUIRED:${model}.${operation}"));
});

test("cache layer rejects unscoped keys and scopes product indexes by shop", () => {
  const cache = read("web/utils/cacheUtils.js");
  assert.ok(cache.includes("CACHE_KEY_REQUIRES_SHOP"));
  assert.ok(cache.includes("tenantFromCacheKey(key)"));
  assert.ok(cache.includes('buildCacheKey(shop, "index", "product", cleanProductId)'));
  assert.equal(cache.includes("`index:product:${cleanProductId}`"), false);
});

test("bulk operation jobs do not propagate complete webhook payloads", () => {
  const worker = read("web/Jobs/Workers/bulkOperationMutationWorker.js");
  assert.equal(worker.includes("payload: job.data || null"), false);
  assert.equal(worker.includes("payload: job.data || {}"), false);
  assert.ok(worker.includes("webhookId: job.data?.webhookId || null"));
});
