import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("installation middleware creates a generation and sends only secure lifecycle data", () => {
  const source = read("web/middleware/appInstallMiddleware.js");

  assert.match(source, /const installationGeneration = randomUUID\(\)/);
  assert.match(source, /installationSetupCompletedAt: null/);
  assert.match(source, /installationStatus: "pending"/);
  assert.match(source, /installedAt: null/);
  assert.match(
    source,
    /addAppInstallationJob\(\{\s*version: 1,\s*shop,\s*installationGeneration,\s*requestedBy: "oauth",\s*\}\)/s,
  );
  assert.doesNotMatch(source, /addAppInstallationJob\(\{[^}]*accessToken/s);
});

test("installation jobs and completion are scoped to the current generation", () => {
  const queueSource = read("web/Jobs/Queues/appInstallationJob.js");
  const workerSource = read("web/Jobs/Workers/appInstallationWorker.js");

  assert.match(queueSource, /data\?\.installationGeneration/);
  assert.match(workerSource, /installationGeneration,\s*isUnInstalled: false/s);
  assert.match(workerSource, /installationSetupCompletedAt: null/);
  assert.match(workerSource, /installationStatus: "processing"/);
  assert.match(workerSource, /installationStatus: "complete"/);
  assert.match(workerSource, /installationStatus: \{ in: \["pending", "processing"\] \}/);
  assert.match(workerSource, /installationProcessingStartedAt: new Date\(\)/);
  assert.match(workerSource, /installationProcessingStartedAt: null/);
  assert.match(workerSource, /claimOrResumeInstallation/);
  assert.match(
    workerSource,
    /installationStatus: "complete",\s*installationProcessingStartedAt: null,\s*installationSetupCompletedAt: new Date\(\),\s*installedAt: new Date\(\)/s,
  );
  const claimSource = workerSource.slice(
    workerSource.indexOf("async function claimOrResumeInstallation"),
    workerSource.indexOf("async function markInstallationSetupCompleted"),
  );
  assert.doesNotMatch(claimSource, /installedAt: new Date\(\)/);
  assert.match(workerSource, /markInstallationSetupCompleted/);
  assert.match(workerSource, /acquireInstallationLock\(shop\)/);
  assert.match(workerSource, /renewRedisLock/);
  assert.match(workerSource, /releaseRedisLock/);
  assert.match(workerSource, /stalledInterval:/);
  assert.match(workerSource, /maxStalledCount:/);
  assert.match(workerSource, /reason: "superseded"/);
  assert.match(workerSource, /error\?\.message === "STALE_INSTALLATION_GENERATION"/);
  assert.match(workerSource, /payloadVersion !== 1/);
  assert.match(workerSource, /unsupported_payload_version/);
});

test("initial install sync checks Shopify query slot and scheduler failures retry", () => {
  const source = read("web/Jobs/Workers/appInstallationWorker.js");

  assert.match(source, /getCurrentBulkOperationStatus\(session, "QUERY"\)/);
  assert.match(source, /INITIAL_PRODUCT_SYNC_BULK_OPERATION_ALREADY_ACTIVE/);
  assert.match(source, /bulkOperationId: currentBulkOperation\.id/);
  assert.match(source, /throw new AggregateError/);
  assert.match(source, /await registerShopRepeatableJobs\(\{ shop, jobId: job\.id \}\)/);
  assert.match(source, /Scheduler registration partially failed/);
});

test("best-effort emails run only after durable installation completion", () => {
  const source = read("web/Jobs/Workers/appInstallationWorker.js");
  const completionIndex = source.indexOf(
    "const completed = await markInstallationSetupCompleted",
  );
  const welcomeEmailIndex = source.indexOf("sentWelcomeMailToStore({");

  assert.ok(completionIndex > 0);
  assert.ok(welcomeEmailIndex > completionIndex);
});

test("installation-owned store writes are generation scoped", () => {
  const middlewareSource = read("web/middleware/appInstallMiddleware.js");
  const workerSource = read("web/Jobs/Workers/appInstallationWorker.js");

  assert.match(middlewareSource, /confirmShopInstallation[\s\S]*installationGeneration/);
  assert.match(middlewareSource, /db\.store\.updateMany\(\{[\s\S]*installationGeneration/);
  assert.doesNotMatch(workerSource, /db\.store\.update\(\{/);
});
