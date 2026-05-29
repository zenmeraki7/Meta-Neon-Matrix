import "./server.js";
import { startJobRunner } from "../workers/jobRunner.js";
import { startReconciliationCron } from "../workers/reconciliation.js";

startJobRunner();
startReconciliationCron();

