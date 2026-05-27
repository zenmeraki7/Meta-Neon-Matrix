import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("bulk edit command and execute worker use authoritative subscription resolver", () => {
  const commandSource = fs.readFileSync(
    path.resolve("web/services/bulkEdit/BulkEditCommandService.js"),
    "utf8",
  );
  const workerSource = fs.readFileSync(
    path.resolve("web/Jobs/Workers/bulkEditExecuteWorker.js"),
    "utf8",
  );

  assert.ok(
    commandSource.includes("loadAuthoritativeSubscriptionForShop"),
    "Command service must load authoritative subscription",
  );
  assert.ok(
    workerSource.includes("loadAuthoritativeSubscriptionForShop"),
    "Execute worker must load authoritative subscription",
  );
});

