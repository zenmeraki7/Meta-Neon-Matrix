import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (file) => fs.readFileSync(path.resolve(file), "utf8");
const lifecycle = read("web/services/operationLifecycleStateMachine.js");
const normalized = read("web/utils/normalizedStateUtils.js");
const schema = read("web/prisma/schema.prisma");

test("verification timeout is a distinct manually resumable lifecycle state", () => {
  assert.ok(lifecycle.includes('VERIFICATION_TIMEOUT: "VERIFICATION_TIMEOUT"'));
  assert.ok(lifecycle.includes('VERIFYING: ["VERIFICATION_TIMEOUT"'));
  assert.ok(lifecycle.includes('VERIFICATION_TIMEOUT: ["VERIFYING", "FAILED", "ROLLING_BACK"]'));
  assert.ok(normalized.includes('case "VERIFICATION_TIMEOUT"'));
  assert.match(schema, /FINALIZING\s+VERIFICATION_TIMEOUT\s+ROLLED_BACK\s+ROLLBACK_FAILED\s+COMPLETED/);
});
