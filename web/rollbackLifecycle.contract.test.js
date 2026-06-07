import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (file) => fs.readFileSync(path.resolve(file), "utf8");
const lifecycle = read("web/services/operationLifecycleStateMachine.js");
const normalized = read("web/utils/normalizedStateUtils.js");
const transition = read("web/services/operationTransitionService.js");
const recovery = read("web/services/bulkEdit/BulkEditRecoveryService.js");
const schema = read("web/prisma/schema.prisma");

test("rollback lifecycle states are normalized and terminal outcomes are persisted", () => {
  assert.ok(lifecycle.includes('ROLLING_BACK: "ROLLING_BACK"'));
  assert.ok(lifecycle.includes('ROLLED_BACK: "ROLLED_BACK"'));
  assert.ok(lifecycle.includes('ROLLBACK_FAILED: "ROLLBACK_FAILED"'));
  assert.ok(lifecycle.includes('ROLLING_BACK: ["ROLLED_BACK", "ROLLBACK_FAILED", "FAILED"]'));
  assert.ok(lifecycle.includes("ROLLED_BACK: []"));
  assert.ok(lifecycle.includes("ROLLBACK_FAILED: []"));
  assert.ok(normalized.includes('case "ROLLED_BACK"'));
  assert.ok(normalized.includes('case "ROLLBACK_FAILED"'));
  assert.ok(transition.includes("const declaredTransitionAllowed = canTransitionOperationState"));
  assert.match(schema, /VERIFICATION_TIMEOUT\s+ROLLED_BACK\s+ROLLBACK_FAILED/);
});

test("admin recovery moves verification timeout back to VERIFYING", () => {
  assert.ok(recovery.includes("currentState === OPERATION_LIFECYCLE_STATES.VERIFICATION_TIMEOUT"));
  assert.ok(recovery.includes("? OPERATION_LIFECYCLE_STATES.VERIFYING"));
  assert.ok(recovery.includes("completedAt: null"));
});
