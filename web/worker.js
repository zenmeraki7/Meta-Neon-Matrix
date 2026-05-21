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

import "./Jobs/Workers/recurringEditExecutionWorker.js";
import "./Jobs/Workers/recurringEditSchedulerWorker.js";
import "./Jobs/Workers/scheduledExportExecutionWorker.js";
import "./Jobs/Workers/scheduledExportSchedulerWorker.js";
import "./Jobs/Workers/automaticProductRuleExecutionWorker.js";
import "./Jobs/Workers/automaticProductRuleSchedulerWorker.js";
import "./Jobs/Workers/automaticProductRuleSignalWorker.js";

console.log(`🚀 Worker process ${process.pid} started`);

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});

// Keep process alive
setInterval(() => {}, 1000 * 60);