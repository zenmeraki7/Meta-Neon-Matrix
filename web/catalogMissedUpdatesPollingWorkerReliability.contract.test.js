import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(
  path.resolve("web/Jobs/Workers/catalogMissedUpdatesPollingWorker.js"),
  "utf8",
);

test("catalog polling paces pages using Shopify cost feedback", () => {
  assert.ok(source.includes("async function paceForThrottle(response)"));
  assert.ok(source.includes("throttleStatus"));
  assert.ok(source.includes("currentlyAvailable"));
  assert.ok(source.includes("restoreRate"));
  assert.ok(source.includes("await paceForThrottle(response)"));
});

test("catalog polling parallelizes readiness checks", () => {
  assert.ok(source.includes("await Promise.all(REQUIRED_TABLES.map"));
  assert.equal(source.includes("for (const table of REQUIRED_TABLES)"), false);
});

test("catalog polling uses renewable per-shop locks with configurable concurrency", () => {
  assert.ok(source.includes("CATALOG_POLL_CONCURRENCY"));
  assert.ok(source.includes("concurrency: POLL_CONCURRENCY"));
  assert.ok(source.includes("catalog-missed-updates-poll:${scopedShop}"));
  assert.ok(source.includes("renewRedisLock({"));
  assert.ok(source.includes("shop_poll_already_running"));
  assert.ok(source.includes("releaseRedisLock({"));
});

test("catalog polling observes stalls and shuts down gracefully", () => {
  assert.ok(source.includes('catalogMissedUpdatesPollingWorker.on("stalled"'));
  assert.ok(source.includes("await catalogMissedUpdatesPollingWorker.close()"));
  assert.ok(source.includes('process.once("SIGTERM"'));
  assert.ok(source.includes('process.once("SIGINT"'));
});
