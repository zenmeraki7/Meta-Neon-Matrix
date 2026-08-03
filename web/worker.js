import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scheduleReconciliationJob } from "./Jobs/Queues/reconciliationJob.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, ".env") });

if (!process.env.HOST && process.env.SHOPIFY_APP_URL) {
  process.env.HOST = process.env.SHOPIFY_APP_URL.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

const requiredEnv = ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "HOST", "DATABASE_URL"];
const missing = requiredEnv.filter((key) => !process.env[key]);
if (!process.env.REDIS_URL && !(process.env.REDIS_HOST && process.env.REDIS_PORT)) {
  missing.push("REDIS_URL|REDIS_HOST+REDIS_PORT");
}
if (missing.length) throw new Error(`Worker missing required env vars: ${missing.join(", ")}`);
if (String(process.env.WEB_PROCESS || "").toLowerCase() === "true") {
  throw new Error("Refusing to start workers in web process (WEB_PROCESS=true)");
}

const [{ connection: redis }, { default: db }] = await Promise.all([
  import("./config/redis.js"),
  import("./repositories/repositoryDb.js"),
]);

const workerModulePaths = [
  "./Jobs/Workers/bulkEditPipelineWorker.js",
  "./Jobs/Workers/bulkEditItemApplyWorker.js",
  "./Jobs/Workers/bulkEditExecuteWorker.js",
  "./Jobs/Workers/bulkExportWorker.js",
  "./Jobs/Workers/bulkUndoWorker.js",
  "./Jobs/Workers/bulkOperationMutationWorker.js",
  "./Jobs/Workers/bulkUndoResultIngestWorker.js",
  "./Jobs/Workers/bulkOperationQueryWorker.js",
  "./Jobs/Workers/appInstallationWorker.js",
  "./Jobs/Workers/scheduledEditWorker.js",
  "./Jobs/Workers/scheduledEditRecoveryWorker.js",
  "./Jobs/Workers/appUninstallWorker.js",
  "./Jobs/Workers/bulkImportEditWorker.js",
  "./Jobs/Workers/shopSyncWorker.js",
  "./Jobs/Workers/productCreateWorker.js",
  "./Jobs/Workers/productUpdateWorker.js",
  "./Jobs/Workers/productDeleteWorker.js",
  "./Jobs/Workers/productSyncWorker.js",
  "./Jobs/Workers/productSyncClearProductTypesWorker.js",
  "./Jobs/Workers/metafieldBulkWriteWorker.js",
  "./Jobs/Workers/operationEnqueueIntentRecoveryWorker.js",
  "./Jobs/Workers/recurringEditExecutionWorker.js",
  "./Jobs/Workers/recurringEditSchedulerWorker.js",
  "./Jobs/Workers/scheduledExportExecutionWorker.js",
  "./Jobs/Workers/scheduledExportSchedulerWorker.js",
  "./Jobs/Workers/automaticProductRuleExecutionWorker.js",
  "./Jobs/Workers/automaticProductRuleSchedulerWorker.js",
  "./Jobs/Workers/automaticProductRuleSignalWorker.js",
  "./Jobs/Workers/targetFreezeQueueWorker.js",
  "./Jobs/Workers/outboxDispatcherWorker.js",
  "./Jobs/Workers/stuckBulkMutationRecoveryWorker.js",
  "./Jobs/Workers/missedBulkOperationPollingWorker.js",
  "./Jobs/Workers/catalogMissedUpdatesPollingWorker.js",
  "./Jobs/Workers/unresolvedBulkOperationRecoveryWorker.js",
  "./Jobs/Workers/bulkEditResultIngestWorker.js",
  "./Jobs/Workers/bulkEditVerificationWorker.js",
  "./Jobs/Workers/subscriptionBillingWorker.js",
  "./Jobs/Workers/reconciliationWorker.js",
  "./Jobs/Workers/mirrorCleanupWorker.js",
];

await scheduleReconciliationJob().catch((error) => {
  console.error("[reconciliation] scheduler registration failed", error.message);
});

const closables = [];
for (const modPath of workerModulePaths) {
  const mod = await import(modPath);
  for (const starter of ["startBulkEditPipelineWorker", "startBulkEditExecuteWorker", "startBulkEditVerificationWorker", "startBulkEditItemApplyWorker"]) {
    if (typeof mod?.[starter] === "function") mod[starter]();
  }
  for (const value of Object.values(mod || {})) {
    if (value && typeof value.close === "function") closables.push(value);
  }
}

console.log(
  `[worker] All ${workerModulePaths.length} worker modules started successfully`,
);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const timer = setTimeout(() => process.exit(1), 15_000);
  timer.unref();
  await Promise.allSettled(closables.map((item) => item.close()));
  await Promise.allSettled([db.$disconnect()]);
  try { await redis.quit(); } catch { redis.disconnect(); }
  clearTimeout(timer);
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", async (error) => { console.error(error); await shutdown("uncaughtException"); });
process.on("unhandledRejection", async (error) => { console.error(error); await shutdown("unhandledRejection"); });
