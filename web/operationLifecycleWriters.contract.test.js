import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canTransitionOperationState,
  OPERATION_LIFECYCLE_STATES,
} from "./services/operationLifecycleStateMachine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WRITER_ROOTS = [
  path.join(__dirname, "services"),
  path.join(__dirname, "Jobs"),
  path.join(__dirname, "helpers"),
];

const FORBIDDEN_LEGACY_STATES = new Set([
  "TARGETING_STARTED",
  "TARGETING_FROZEN",
  "QUEUED_FOR_EXECUTION",
]);

function collectJsFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    if (!current || !fs.existsSync(current)) continue;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        out.push(fullPath);
      }
    }
  }
  return out;
}

function findForbiddenExecutionStateAssignments(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const violations = [];
  const re = /executionState\s*:\s*"([A-Z_]+)"/g;
  let match = re.exec(content);
  while (match) {
    const state = match[1];
    if (FORBIDDEN_LEGACY_STATES.has(state)) {
      violations.push(state);
    }
    match = re.exec(content);
  }
  return violations;
}

test("backend writers do not assign forbidden legacy execution states", () => {
  const files = WRITER_ROOTS.flatMap((root) => collectJsFiles(root));
  const offenders = [];
  for (const filePath of files) {
    const violations = findForbiddenExecutionStateAssignments(filePath);
    if (violations.length > 0) {
      offenders.push({
        filePath,
        states: [...new Set(violations)],
      });
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Forbidden legacy executionState assignments found:\n${JSON.stringify(offenders, null, 2)}`,
  );
});

test("lifecycle transition contract blocks invalid jumps and allows expected pipeline", () => {
  const S = OPERATION_LIFECYCLE_STATES;

  // Expected happy path
  assert.equal(canTransitionOperationState(S.QUEUED, S.EXECUTING), true);
  assert.equal(canTransitionOperationState(S.EXECUTING, S.SHOPIFY_BULK_SUBMITTED), true);
  assert.equal(canTransitionOperationState(S.SHOPIFY_BULK_SUBMITTED, S.SHOPIFY_RUNNING), true);
  assert.equal(canTransitionOperationState(S.SHOPIFY_RUNNING, S.SHOPIFY_COMPLETED), true);
  assert.equal(canTransitionOperationState(S.SHOPIFY_COMPLETED, S.INGESTING_RESULTS), true);
  assert.equal(canTransitionOperationState(S.INGESTING_RESULTS, S.VERIFYING), true);
  assert.equal(canTransitionOperationState(S.VERIFYING, S.MIRROR_UPDATING), true);
  assert.equal(canTransitionOperationState(S.MIRROR_UPDATING, S.COMPLETED), true);

  // Invalid jumps
  assert.equal(canTransitionOperationState(S.QUEUED, S.COMPLETED), false);
  assert.equal(canTransitionOperationState(S.TARGET_FREEZING, S.EXECUTING), false);
  assert.equal(canTransitionOperationState(S.CANCELLED, S.EXECUTING), false);
  assert.equal(canTransitionOperationState(S.COMPLETED, S.EXECUTING), false);
});
