import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

const repository = read("web/repositories/storeRepository.js");
const middleware = read("web/middleware/appInstallMiddleware.js");
const schema = read("web/prisma/schema.prisma");

test("store session upsert preserves install date and avoids empty placeholder email", () => {
  const ensureStore = repository.slice(
    repository.indexOf("export async function ensureStoreForSession"),
    repository.indexOf("export async function recoverStaleProductSyncStateByShop"),
  );
  const updateBlock = ensureStore.slice(
    ensureStore.indexOf("update: {"),
    ensureStore.indexOf("select: {", ensureStore.indexOf("update: {")),
  );

  assert.match(schema, /shopEmail\s+String\?/);
  assert.match(ensureStore, /shopEmail: session\?\.email \|\| null/);
  assert.match(ensureStore, /existingStore\?\.isUnInstalled[\s\S]*\? \{ installedAt: new Date\(\) \}/);
  assert.match(updateBlock, /\.\.\.reinstallPatch/);
  assert.doesNotMatch(updateBlock, /installedAt:\s*new Date\(\)/);
  assert.doesNotMatch(ensureStore, /shopEmail:\s*""/);
  assert.doesNotMatch(middleware, /shopEmail:\s*""/);
});

test("stale product sync recovery is guarded by an atomic stale-state update", () => {
  const recovery = repository.slice(
    repository.indexOf("export async function recoverStaleProductSyncStateByShop"),
    repository.indexOf("export async function getStoreSyncStateByShop"),
  );

  assert.match(recovery, /prisma\.store\.updateMany\(\{/);
  assert.match(recovery, /shopUrl: resolvedShop/);
  assert.match(recovery, /isProductSyncing: true,\s*productSyncStartedAt: \{ lt: cutoff \}/);
  assert.match(recovery, /syncProgressStage: \{ in: PRODUCT_SYNC_RUNNING_STAGES \}/);
  assert.doesNotMatch(recovery, /updatedAt: \{ lt: cutoff \}/);
  assert.match(recovery, /return \{ recovered: recovered\.count > 0 \}/);
  assert.doesNotMatch(recovery, /prisma\.store\.update\(\{/);
});
