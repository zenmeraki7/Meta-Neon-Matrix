import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const source = fs.readFileSync("web/services/syncStatusQueryService.js", "utf8");
const publicFunctions = source.slice(source.indexOf("export async function getSyncStatusDetailForShop"));

test("sync status recovery is cooled down per shop", () => {
  assert.match(source, /const RECOVERY_COOLDOWN_MS = 60_000/);
  assert.match(source, /const recoveryLastRanByShop = new Map\(\)/);
  assert.match(source, /async function maybeRecoverStaleSync\(shop\)/);
  assert.match(source, /now - lastRanAt < RECOVERY_COOLDOWN_MS/);
  assert.match(source, /const recovery = await recoverStaleProductSyncStateByShop\(shop\)/);
  assert.match(source, /return recovery/);
  assert.doesNotMatch(publicFunctions, /recoverStaleProductSyncStateByShop\(shop\)/);
});

test("sync status recovery clears cached status views", () => {
  assert.match(source, /import \{ clearKeyCaches, getCache, setCache \}/);
  assert.match(source, /async function clearSyncStatusCaches\(shop\)/);
  assert.match(source, /clearKeyCaches\(`\$\{shop\}:sync_details`\)/);
  assert.match(source, /clearKeyCaches\(`\$\{shop\}:sync_summary:v2`\)/);
  assert.match(source, /clearKeyCaches\(`\$\{shop\}:sync_active_product_count`\)/);
  assert.match(source, /if \(recovery\.recovered\) \{\s*await clearSyncStatusCaches\(shop\);/s);
});

test("sync status caches detail and summary on the same short ttl", () => {
  assert.match(source, /const SYNC_STATUS_CACHE_TTL_SECONDS = 60/);
  assert.match(source, /await setCache\(cacheKey, syncDetails, SYNC_STATUS_CACHE_TTL_SECONDS\)/);
  assert.match(source, /await setCache\(cacheKey, syncSummary, SYNC_STATUS_CACHE_TTL_SECONDS\)/);
  assert.doesNotMatch(source, /setCache\(cacheKey, syncDetails, 300\)/);
});

test("sync status summary caches active product row counts briefly", () => {
  assert.match(source, /const ACTIVE_PRODUCT_COUNT_TTL_SECONDS = 20/);
  assert.match(source, /sync_active_product_count:\$\{store\.activeMirrorBatchId\}/);
  assert.match(source, /const cached = await getCache\(cacheKey\)/);
  assert.match(source, /await setCache\(cacheKey, count, ACTIVE_PRODUCT_COUNT_TTL_SECONDS\)/);
});

test("tracked sync status explains zero total progress during active sync", () => {
  assert.match(source, /function syncingProgressMessage\(totalProducts\)/);
  assert.match(source, /Total product count is still being prepared/);
  assert.match(source, /message: syncingProgressMessage\(totalProducts\)/);
});

test("legacy initial sync field typo is documented where read", () => {
  assert.match(source, /Legacy schema spelling: the DB column is isProductInitialySyning/);
});
