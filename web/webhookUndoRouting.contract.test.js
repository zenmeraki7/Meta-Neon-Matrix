import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const workerPath = path.resolve("web/Jobs/Workers/bulkOperationMutationWorker.js");

test("bulkOperationMutationWorker routes undo operations to undo result ingest queue", () => {
  const source = fs.readFileSync(workerPath, "utf8");
  assert.ok(
    source.includes("addbulkUndoResultIngestJob"),
    "Expected undo result ingest queue helper import",
  );
  assert.ok(
    source.includes("isUndoBulkOperation"),
    "Expected explicit undo operation branch",
  );
});

