import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test("legacy bulkEditWorker is removed from runtime", () => {
  const workerPath = path.join(__dirname, "Jobs", "Workers", "bulkEditWorker.js");
  assert.equal(
    fs.existsSync(workerPath),
    false,
    "legacy bulkEditWorker.js must be deleted",
  );

  const workerBootstrapPath = path.join(__dirname, "worker.js");
  const source = fs.readFileSync(workerBootstrapPath, "utf8");
  assert.equal(
    source.includes("./Jobs/Workers/bulkEditWorker.js"),
    false,
    "worker bootstrap must not import legacy bulkEditWorker",
  );
});
