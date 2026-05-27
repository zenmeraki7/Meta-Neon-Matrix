import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(file) {
  return fs.readFileSync(path.resolve(file), "utf8");
}

test("transition service enforces fence-token compare-and-set", () => {
  const src = read("web/services/operationTransitionService.js");
  assert.ok(src.includes("expectedFenceToken !== null"));
  assert.ok(src.includes('reason: "STALE_FENCE_TOKEN"'));
  assert.ok(src.includes('path: ["executeLeaseFencingToken"]'));
});

test("transition service blocks terminal-state mutation by default", () => {
  const src = read("web/services/operationTransitionService.js");
  assert.ok(src.includes("TERMINAL_STATES"));
  assert.ok(src.includes('reason: "TERMINAL_STATE_MUTATION_REJECTED"'));
});

test("transition service supports explicit allowlisted admin recovery override", () => {
  const src = read("web/services/operationTransitionService.js");
  assert.ok(src.includes("RECOVERY_ALLOWED_TERMINAL_OVERRIDES"));
  assert.ok(src.includes("allowTerminalOverride"));
});

test("transition service provides duplicate transition idempotent-safe return", () => {
  const src = read("web/services/operationTransitionService.js");
  assert.ok(src.includes("isSameTransition"));
  assert.ok(src.includes("idempotent: true"));
});

test("bulk result ingest and recovery paths are wired to transitionOperation", () => {
  const worker = read("web/Jobs/Workers/bulkEditResultIngestWorker.js");
  const ingest = read("web/services/bulkEdit/BulkEditResultIngestionService.js");
  const recovery = read("web/services/bulkEdit/BulkEditRecoveryService.js");
  assert.ok(worker.includes("transitionOperation("));
  assert.ok(ingest.includes("transitionOperation("));
  assert.ok(recovery.includes("transitionOperation("));
});

test("admin recovery enforces actor scope and reason", () => {
  const src = read("web/services/bulkEdit/BulkEditRecoveryService.js");
  assert.ok(src.includes("RECOVERY_REASON_REQUIRED"));
  assert.ok(src.includes("RECOVERY_ACTOR_SCOPE_REQUIRED"));
  assert.ok(src.includes("RECOVERY_ACTOR_ID_REQUIRED"));
});

