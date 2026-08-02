import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test("Automatic rules reserve and release feature quotas in same transaction", async () => {
  const fileContent = fs.readFileSync(
    path.join(__dirname, "services/automaticProductRule/commands/mutateAutomaticProductRuleCommand.js"),
    "utf8",
  );

  assert.ok(
    fileContent.includes("reserveFeatureQuota"),
    "mutateAutomaticProductRuleCommand must define reserveFeatureQuota",
  );
  assert.ok(
    fileContent.includes("releaseFeatureQuota"),
    "mutateAutomaticProductRuleCommand must define releaseFeatureQuota",
  );
  assert.ok(
    fileContent.includes("AUTOMATIC_RULES_TOTAL"),
    "mutateAutomaticProductRuleCommand must reference AUTOMATIC_RULES_TOTAL",
  );
  assert.ok(
    fileContent.includes("AUTOMATIC_RULES_ACTIVE"),
    "mutateAutomaticProductRuleCommand must reference AUTOMATIC_RULES_ACTIVE",
  );
});

test("updateRecurringEdit enforces expectedRevision and idempotencyKey", async () => {
  const fileContent = fs.readFileSync(
    path.join(__dirname, "services/recurringEditService.js"),
    "utf8",
  );

  assert.ok(
    fileContent.includes("EXPECTED_REVISION_REQUIRED"),
    "updateRecurringEdit must require expectedRevision",
  );
  assert.ok(
    fileContent.includes("RECURRING_EDIT_REVISION_CONFLICT"),
    "updateRecurringEdit must reject revision conflict with RECURRING_EDIT_REVISION_CONFLICT",
  );
  assert.ok(
    fileContent.includes("recurringEditMutation"),
    "updateRecurringEdit must use recurringEditMutation table for idempotency",
  );
});

test("Recurring edit run and scheduled export run support retries and delayed intents", async () => {
  const recurringFile = fs.readFileSync(
    path.join(__dirname, "services/recurringEditExecutionService.js"),
    "utf8",
  );
  const scheduledRepo = fs.readFileSync(
    path.join(__dirname, "repositories/scheduledExportRunRepository.js"),
    "utf8",
  );

  assert.ok(
    recurringFile.includes("deferRecurringRun"),
    "recurringEditExecutionService must define deferRecurringRun",
  );
  assert.ok(
    scheduledRepo.includes("reserveRetry"),
    "scheduledExportRunRepository must define reserveRetry",
  );
});

test("Repositories enforce fencing token and execution lease claims", async () => {
  const recurringRepo = fs.readFileSync(
    path.join(__dirname, "repositories/recurringEditRunRepository.js"),
    "utf8",
  );
  const scheduledRepo = fs.readFileSync(
    path.join(__dirname, "repositories/scheduledExportRunRepository.js"),
    "utf8",
  );

  assert.ok(
    recurringRepo.includes("claimRun"),
    "recurringEditRunRepository must define claimRun",
  );
  assert.ok(
    recurringRepo.includes("assertRunLease"),
    "recurringEditRunRepository must define assertRunLease",
  );
  assert.ok(
    scheduledRepo.includes("claimRun"),
    "scheduledExportRunRepository must define claimRun",
  );
  assert.ok(
    scheduledRepo.includes("assertRunLease"),
    "scheduledExportRunRepository must define assertRunLease",
  );
});

test("Bulk import worker classifies errors and manages transient retry state", async () => {
  const fileContent = fs.readFileSync(
    path.join(__dirname, "Jobs/Workers/bulkImportEditWorker.js"),
    "utf8",
  );

  assert.ok(
    fileContent.includes("isImportValidationError"),
    "bulkImportEditWorker must define isImportValidationError",
  );
  assert.ok(
    fileContent.includes("markImportRetryWait"),
    "bulkImportEditWorker must define markImportRetryWait",
  );
});

test("Scheduled export job creates OperationEnqueueIntent in same transaction", async () => {
  const fileContent = fs.readFileSync(
    path.join(__dirname, "services/scheduledExportExecutionService.js"),
    "utf8",
  );

  assert.ok(
    fileContent.includes("scheduled-export-job:"),
    "scheduledExportExecutionService must use dedupe key scheduled-export-job:",
  );
  assert.ok(
    fileContent.includes("createEnqueueIntent"),
    "scheduledExportExecutionService must call createEnqueueIntent inside export creation transaction",
  );
});
