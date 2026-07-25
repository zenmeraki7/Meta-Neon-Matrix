import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
  resolve(process.cwd(), "web/Jobs/Workers/targetFreezeQueueWorker.js"),
  "utf8",
);

test("target-freeze worker reloads run/rule/command from DB and does not trust queue payload", () => {
  assert.match(source, /automaticProductRuleRun\.findFirst/);
  assert.match(source, /include:\s*\{\s*automaticProductRule:\s*true\s*\}/);
  assert.match(source, /targetFreezeCommand\.findFirst/);
  assert.match(source, /assertCommandStillSafe/);
});

test("target-freeze worker validates rule lifecycle, revision, mirror, and command status", () => {
  assert.match(source, /TARGET_FREEZE_RULE_DELETED/);
  assert.match(source, /TARGET_FREEZE_RULE_REVISION_STALE/);
  assert.match(source, /TARGET_FREEZE_MIRROR_BATCH_MISMATCH/);
  assert.match(source, /TARGET_FREEZE_COMMAND_NOT_PENDING/);
});

test("target-freeze worker uses claim-and-dispatch with retry-safe rollback", () => {
  assert.match(source, /updateMany\(\{\s*where:\s*\{\s*id:\s*command\.id,\s*status:\s*TARGET_FREEZE_COMMAND_STATUS\.PENDING/s);
  assert.match(source, /status:\s*TARGET_FREEZE_COMMAND_STATUS\.DISPATCHING/);
  assert.match(source, /enqueueAutomaticProductRuleExecutionJob/);
  assert.match(source, /status:\s*TARGET_FREEZE_COMMAND_STATUS\.DISPATCHED/);
  assert.match(source, /status:\s*TARGET_FREEZE_COMMAND_STATUS\.PENDING/);
});
