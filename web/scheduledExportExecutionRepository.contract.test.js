import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const source = fs.readFileSync("web/repositories/scheduledExportExecutionRepository.js", "utf8");

test("scheduled export advisory locks use 64-bit hash and session wrapper releases", () => {
  assert.match(source, /substr\(md5\(\$\{lockKey\}\), 1, 16\)\)::bit\(64\)::bigint/);
  assert.match(source, /export async function withAdvisoryLockSession\(lockKey, fn\)/);
  assert.match(source, /const locked = await tryAdvisoryLockSession\(lockKey\)/);
  assert.match(source, /finally \{\s*await unlockAdvisoryLockSession\(lockKey\)\.catch\(\(\) => \{\}\);/s);
});

test("scheduled export repository guards shop-scoped lookup and create inputs", () => {
  assert.match(source, /EXPORT_JOB_LOOKUP_REQUIRES_SHOP_AND_RUN_ID/);
  assert.match(source, /normalizeCreateData\(data, "EXPORT_JOB_CREATE_REQUIRES_SHOP"\)/);
  assert.match(source, /normalizeCreateData\(data, "EXPORT_HISTORY_CREATE_REQUIRES_SHOP"\)/);
  assert.match(source, /if \(!data\.shop\)/);
});

test("scheduled export target frozen state is explicit and overridable", () => {
  assert.match(source, /targetFrozenExecutionState = "TARGET_FROZEN"/);
  assert.match(source, /executionState: targetFrozenExecutionState/);
});
