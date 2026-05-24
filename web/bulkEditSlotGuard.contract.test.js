import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test("legacy bulkEditWorker does not perform direct Shopify slot check", () => {
  const workerPath = path.join(__dirname, "Jobs", "Workers", "bulkEditWorker.js");
  const source = fs.readFileSync(workerPath, "utf8");
  assert.equal(
    source.includes("getCurrentBulkOperationStatus("),
    false,
    "bulkEditWorker must not do direct slot checks; submission service owns this policy",
  );
});
