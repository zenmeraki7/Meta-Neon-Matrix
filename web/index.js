import "./server.js";
import { scheduleReconciliationJob } from "./Jobs/Queues/reconciliationJob.js";

void scheduleReconciliationJob().catch((error) => {
  // Keep web process alive; worker runtime will continue existing jobs.
  console.error("[reconciliation] failed to register repeatable job", error?.message || error);
});
