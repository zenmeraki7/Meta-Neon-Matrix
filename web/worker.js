import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { connection as redis } from "./config/redis.js";
import db from "./repositories/repositoryDb.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, ".env") });

if (!process.env.HOST && process.env.SHOPIFY_APP_URL) {
  process.env.HOST = process.env.SHOPIFY_APP_URL
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

const requiredEnv = [
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "HOST",
  "DATABASE_URL",
];

const missing = requiredEnv.filter((key) => !process.env[key]);
const hasRedisUrl = Boolean(process.env.REDIS_URL);
const hasRedisHostPort = Boolean(process.env.REDIS_HOST && process.env.REDIS_PORT);
if (!hasRedisUrl && !hasRedisHostPort) {
  missing.push("REDIS_URL|REDIS_HOST+REDIS_PORT");
}
if (missing.length > 0) {
  throw new Error(`Worker missing required env vars: ${missing.join(", ")}`);
}

if (String(process.env.WEB_PROCESS || "").toLowerCase() === "true") {
  throw new Error("Refusing to start workers in web process (WEB_PROCESS=true)");
}
if (String(process.env.WORKER_PROCESS || "").toLowerCase() !== "true") {
  console.warn("WORKER_PROCESS is not explicitly true; starting workers anyway");
}

console.log(`Worker process ${process.pid} starting`);

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
];

const closables = [];
for (const modPath of workerModulePaths) {
  // eslint-disable-next-line no-await-in-loop
  const mod = await import(modPath);
  if (typeof mod?.startBulkEditPipelineWorker === "function") {
    mod.startBulkEditPipelineWorker();
  }
  if (typeof mod?.startBulkEditExecuteWorker === "function") {
    mod.startBulkEditExecuteWorker();
  }
  if (typeof mod?.startBulkEditVerificationWorker === "function") {
    mod.startBulkEditVerificationWorker();
  }
  if (typeof mod?.startBulkEditItemApplyWorker === "function") {
    mod.startBulkEditItemApplyWorker();
  }
  for (const value of Object.values(mod || {})) {
    if (value && typeof value.close === "function") {
      closables.push(value);
    }
  }
}

console.log(`Worker process ${process.pid} started`);

let shuttingDown = false;
let redisClosed = false;

async function closeRedisOnce() {
  if (redisClosed) return;
  redisClosed = true;

  try {
    await redis.quit();
  } catch {
    try {
      redis.disconnect();
    } catch {
      // noop
    }
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Worker ${process.pid} received ${signal}; shutting down`);
  const hardExitTimer = setTimeout(() => {
    console.error(`Worker ${process.pid} forced exit after shutdown timeout`);
    process.exit(1);
  }, 15000);
  hardExitTimer.unref();
  await Promise.allSettled(closables.map((c) => c.close()));
  await Promise.allSettled([db.$disconnect()]);
  await closeRedisOnce();
  clearTimeout(hardExitTimer);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", async (err) => {
  console.error("Uncaught Exception:", err);
  await shutdown("uncaughtException");
});
process.on("unhandledRejection", async (err) => {
  console.error("Unhandled Rejection:", err);
  await shutdown("unhandledRejection");
});
