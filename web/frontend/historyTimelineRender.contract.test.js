import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function read(filePath) {
  return fs.readFileSync(path.join(ROOT, filePath), "utf8");
}

test("history row/details views render lifecycle timeline state", () => {
  const historyTable = read("web/frontend/Domain/History/components/HistoryTable.jsx");
  const editDetails = read("web/frontend/Domain/products/edit/pages/EditDetails.jsx");

  assert.equal(
    historyTable.includes("buildOperationTimeline"),
    true,
    "HistoryTable should render lifecycle timeline state",
  );
  assert.equal(
    historyTable.includes("Tooltip"),
    true,
    "HistoryTable should include per-stage lifecycle tooltips",
  );
  assert.equal(
    historyTable.includes("idempotencyStages"),
    true,
    "HistoryTable should read supportStatus.idempotencyStages for stage timestamps",
  );
  assert.equal(
    historyTable.includes("stages"),
    true,
    "HistoryTable should show stage progression summary",
  );
  assert.equal(
    editDetails.includes("Operation lifecycle"),
    true,
    "EditDetails should include lifecycle timeline section",
  );
});
