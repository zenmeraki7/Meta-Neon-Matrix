import dotenv from "dotenv";
dotenv.config();

// Workers
import "./Jobs/Workers/bulkEditWorker.js";
import "./Jobs/Workers/bulkExportWorker.js";
import "./Jobs/Workers/bulkUndoWorker.js";
import "./Jobs/Workers/bulkOperationMutationWorker.js";
import "./Jobs/Workers/bulkOperationQueryWorker.js";
import "./Jobs/Workers/appInstallationWorker.js";
import "./Jobs/Workers/scheduledEditWorker.js";
import "./Jobs/Workers/appUninstallWorker.js";
import "./Jobs/Workers/bulkImportEditWorker.js";
import "./Jobs/Workers/shopSyncWorker.js";

import "./workers/recurringEditExecutionWorker.js";
import "./workers/recurringEditSchedulerWorker.js";
import "./workers/scheduledExportExecutionWorker.js";
import "./workers/scheduledExportSchedulerWorker.js";
import "./workers/automaticProductRuleExecutionWorker.js";
import "./workers/automaticProductRuleSchedulerWorker.js";
import "./workers/automaticProductRuleSignalWorker.js";

console.log(`🚀 Worker process ${process.pid} started`);

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});

// Keep process alive
setInterval(() => {}, 1000 * 60);