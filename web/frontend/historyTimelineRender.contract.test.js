import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function read(filePath) {
  return fs.readFileSync(path.join(ROOT, filePath), "utf8");
}

test("history list hides worker lifecycle details while details keeps lifecycle timeline", () => {
  const historyTable = read("web/frontend/Domain/History/components/HistoryTable.jsx");
  const jobProgressCell = read("web/frontend/Domain/History/components/JobProgressCell.tsx");
  const editDetails = read("web/frontend/Domain/products/edit/pages/EditDetails.jsx");

  assert.equal(
    historyTable.includes("JobProgressCell"),
    true,
    "HistoryTable should render the merchant-facing progress cell",
  );
  assert.equal(
    historyTable.includes("timelineSummary"),
    false,
    "HistoryTable must not render lifecycle timeline state",
  );
  assert.equal(
    historyTable.includes("stageBadges"),
    false,
    "HistoryTable must not render internal stage badges",
  );
  assert.equal(
    jobProgressCell.includes("STATUS_CONFIG"),
    true,
    "JobProgressCell should own the status-to-badge-and-progress color config",
  );
  assert.equal(
    jobProgressCell.includes("export function calculateProgress(job"),
    true,
    "JobProgressCell should expose the single progress calculation function",
  );
  assert.equal(
    jobProgressCell.includes("Math.max(totalItems, 1)"),
    true,
    "JobProgressCell should protect progress calculation against divide-by-zero",
  );
  assert.equal(
    jobProgressCell.includes("firstProvidedCount"),
    true,
    "JobProgressCell should honor an explicit zero progress count for failed jobs",
  );
  assert.equal(
    editDetails.includes("Operation lifecycle"),
    true,
    "EditDetails should include lifecycle timeline section",
  );
});
