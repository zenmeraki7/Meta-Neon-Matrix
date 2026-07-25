import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SNAPSHOT_PATH = path.resolve("web/frontend/perf/profiler.snapshots.json");
const REQUIRED_ACTIONS = [
  "one_filter_char",
  "one_row_action_click",
  "one_page_change",
];

function asNumber(value, label) {
  const parsed = Number(value);
  assert.ok(Number.isFinite(parsed), `${label} must be a finite number`);
  return parsed;
}

test("profiler snapshot file exists for required perf actions", () => {
  assert.ok(fs.existsSync(SNAPSHOT_PATH), `Missing profiler snapshot file: ${SNAPSHOT_PATH}`);
  const raw = fs.readFileSync(SNAPSHOT_PATH, "utf8");
  const data = JSON.parse(raw);

  assert.ok(data && typeof data === "object", "Snapshot payload must be an object");
  assert.ok(data.actions && typeof data.actions === "object", "Snapshot payload must include actions");
  assert.ok(data.budgets && typeof data.budgets === "object", "Snapshot payload must include budgets");

  for (const action of REQUIRED_ACTIONS) {
    assert.ok(data.actions[action], `Missing action snapshot: ${action}`);
    assert.ok(data.budgets[action], `Missing action budget: ${action}`);
  }
});

test("profiler actions stay inside render-count and commit-duration budgets", () => {
  const raw = fs.readFileSync(SNAPSHOT_PATH, "utf8");
  const data = JSON.parse(raw);

  for (const action of REQUIRED_ACTIONS) {
    const measurement = data.actions[action];
    const budget = data.budgets[action];

    const renderedComponentCount = asNumber(
      measurement.renderedComponentCount,
      `${action}.renderedComponentCount`,
    );
    const commitDurationMs = asNumber(
      measurement.commitDurationMs,
      `${action}.commitDurationMs`,
    );
    const maxRenderedComponentCount = asNumber(
      budget.maxRenderedComponentCount,
      `${action}.maxRenderedComponentCount`,
    );
    const maxCommitDurationMs = asNumber(
      budget.maxCommitDurationMs,
      `${action}.maxCommitDurationMs`,
    );

    assert.equal(
      Boolean(measurement.allRowsRerendered),
      false,
      `${action} must not re-render all rows`,
    );
    assert.ok(
      renderedComponentCount <= maxRenderedComponentCount,
      `${action} renderedComponentCount ${renderedComponentCount} exceeded budget ${maxRenderedComponentCount}`,
    );
    assert.ok(
      commitDurationMs <= maxCommitDurationMs,
      `${action} commitDurationMs ${commitDurationMs} exceeded budget ${maxCommitDurationMs}`,
    );
  }
});

