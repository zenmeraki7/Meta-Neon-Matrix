import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (relativePath) =>
  fs.readFileSync(path.resolve(relativePath), "utf8");

test("bulk submission schema persists result URL expiry and processing state", () => {
  const schema = read("web/prisma/schema.prisma");
  assert.match(schema, /resultUrl\s+String\?/);
  assert.match(schema, /resultUrlExpiresAt\s+DateTime\?/);
  assert.match(schema, /processedAt\s+DateTime\?/);
  assert.match(schema, /lastError\s+String\?/);
});

test("result ingestion records URL expiry and processed completion", () => {
  const worker = read("web/Jobs/Workers/bulkEditResultIngestWorker.js");
  assert.ok(worker.includes("recordBulkSubmissionResultUrl"));
  assert.ok(worker.includes("markBulkSubmissionProcessed"));
});

test("hourly expiry checker is registered and bootstrapped", () => {
  const installation = read("web/Jobs/Workers/appInstallationWorker.js");
  const bootstrap = read("web/worker.js");
  const reconciliation = read("web/Jobs/Workers/reconciliationWorker.js");
  assert.ok(installation.includes("enqueueResultFileExpiryCheckTick"));
  assert.ok(installation.includes("60 * 60 * 1000"));
  assert.ok(bootstrap.includes("resultFileExpiryCheckWorker.js"));
  assert.ok(reconciliation.includes("checkExpiringResultFiles"));
});
