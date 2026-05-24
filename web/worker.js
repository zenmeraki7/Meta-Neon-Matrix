// web/worker.js
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

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

if (missing.length > 0) {
  throw new Error(`Worker missing required env vars: ${missing.join(", ")}`);
}

console.log("✅ Worker env loaded");
console.log(`🚀 Worker process ${process.pid} starting`);

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});

await import("./Jobs/Workers/bulkEditWorker.js");
await import("./Jobs/Workers/bulkEditPipelineWorker.js");
await import("./Jobs/Workers/bulkExportWorker.js");
await import("./Jobs/Workers/bulkUndoWorker.js");
await import("./Jobs/Workers/bulkOperationMutationWorker.js");
await import("./Jobs/Workers/bulkOperationQueryWorker.js");
await import("./Jobs/Workers/appInstallationWorker.js");
await import("./Jobs/Workers/scheduledEditWorker.js");
await import("./Jobs/Workers/scheduledEditRecoveryWorker.js");
await import("./Jobs/Workers/appUninstallWorker.js");
await import("./Jobs/Workers/bulkImportEditWorker.js");
await import("./Jobs/Workers/shopSyncWorker.js");

await import("./Jobs/Workers/recurringEditExecutionWorker.js");
await import("./Jobs/Workers/recurringEditSchedulerWorker.js");
await import("./Jobs/Workers/scheduledExportExecutionWorker.js");
await import("./Jobs/Workers/scheduledExportSchedulerWorker.js");
await import("./Jobs/Workers/automaticProductRuleExecutionWorker.js");
await import("./Jobs/Workers/automaticProductRuleSchedulerWorker.js");
await import("./Jobs/Workers/automaticProductRuleSignalWorker.js");
await import("./Jobs/Workers/stuckBulkMutationRecoveryWorker.js");

console.log(`✅ Worker process ${process.pid} started`);

setInterval(() => {}, 1000 * 60);
