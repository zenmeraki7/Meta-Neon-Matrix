import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(file) {
  return fs.readFileSync(path.resolve(file), "utf8");
}

test("planned edit history is not projected as queued or target-frozen", () => {
  const source = read("web/services/historyStatusProjectionService.js");

  assert.ok(source.includes('"PLANNED",'));
  assert.equal(
    source.includes("PLANNED: \"QUEUED\""),
    false,
    "PLANNED must not alias to QUEUED in lifecycle projection",
  );
  assert.ok(source.includes('key: "planned"'));
  assert.ok(source.includes("Waiting for the import worker to prepare targets."));
  assert.equal(
    source.includes('normalizedExecutionState === "QUEUED" || normalizedExecutionState === "PLANNED"'),
    false,
    "PLANNED merchant safety state must not be collapsed into Queued",
  );
});
