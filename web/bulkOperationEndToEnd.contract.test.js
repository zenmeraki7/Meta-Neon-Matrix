import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relPath) {
  return fs.readFileSync(path.resolve(relPath), "utf8");
}

const FILES = {
  mutationService: "web/services/bulkEdit/ShopifyBulkMutationService.js",
  resultWorker: "web/Jobs/Workers/bulkEditResultIngestWorker.js",
  resultService: "web/services/bulkEdit/BulkEditResultIngestionService.js",
  verifyService: "web/services/bulkEdit/BulkEditVerificationService.js",
  retryService: "web/services/productService/BulkEditRetryService.js",
  mutationWebhookWorker: "web/Jobs/Workers/bulkOperationMutationWorker.js",
  queueResultIngest: "web/Jobs/Queues/bulkEditResultIngestJob.js",
  recoveryWorker: "web/Jobs/Workers/stuckBulkMutationRecoveryWorker.js",
  missedWebhookPollingWorker: "web/Jobs/Workers/missedBulkOperationPollingWorker.js",
  manualRecovery: "web/recoverStuckEdits.js",
  legacyFinalizer: "web/helpers/webhookHelpers/bulkOperations/bulkEdit.js",
  runtimeHarness: "web/shopifySubmissionCrashRecovery.runtime.test.js",
};

test("1) active currentBulkOperation blocks submit", () => {
  const src = read(FILES.mutationService);
  assert.ok(src.includes("assertNoActiveMutationOperation"));
  assert.ok(src.includes("WAITING_FOR_SHOPIFY_SLOT"));
  assert.ok(src.includes("stageStatus: \"WAITING_SLOT\""));
});

test("2) staged upload userErrors handled", () => {
  const src = read(FILES.mutationService);
  assert.ok(src.includes("stagedUploadsCreate?.userErrors"));
  assert.ok(src.includes("Shopify staged upload returned errors"));
});

test("3) bulkOperationRunMutation userErrors handled", () => {
  const src = read(FILES.mutationService);
  assert.ok(src.includes("bulkOperationRunMutation?.userErrors"));
  assert.ok(src.includes("Bulk operation returned errors"));
});

test("4) bulkOperationId persisted durably", () => {
  const src = read(FILES.mutationService);
  assert.ok(src.includes("bulkSubmission.create"));
  assert.ok(src.includes("shopifyBulkOperationId: bulkOperation.id"));
  assert.ok(src.includes("shopifyBulkOperation: {"));
});

test("5) crash after submit recovery path present", () => {
  const src = read(FILES.mutationService);
  assert.ok(src.includes("submissionStage: \"SUBMIT_RESPONSE_RECEIVED\""));
  assert.ok(src.includes("PENDING_SUBMIT_INTENT_REQUIRES_RECONCILIATION"));
  assert.ok(src.includes("reconciled: true"));
  assert.ok(fs.existsSync(path.resolve(FILES.runtimeHarness)));
});

test("6) webhook duplicate idempotency defenses present", () => {
  const queueSrc = read(FILES.queueResultIngest);
  const workerSrc = read(FILES.resultWorker);
  assert.ok(queueSrc.includes("buildWebhookJobId"));
  assert.ok(workerSrc.includes("already_ingested"));
});

test("7) webhook-before-DB-update recovery logic present", () => {
  const src = read(FILES.mutationService);
  const routeSrc = read(FILES.mutationWebhookWorker);
  assert.ok(src.includes("shopifySubmissionIntent"));
  assert.ok(src.includes("pendingIntent: true"));
  assert.ok(routeSrc.includes("resolveOperationKindByLedger"));
});

test("8) missed webhook polling/recovery fallback present", () => {
  const src = read(FILES.recoveryWorker);
  const polling = read(FILES.missedWebhookPollingWorker);
  assert.ok(src.includes("recoverStuckBulkMutations"));
  assert.ok(polling.includes("pollMissedBulkOperations"));
  assert.ok(polling.includes("BULK_OPERATION_RESULT_QUERY"));
  assert.ok(polling.includes("poll-missed-bulk-operations"));
  assert.ok(polling.includes("SHOPIFY_RUNNING"));
  assert.ok(polling.includes("INGESTING_RESULTS"));
});

test("9) result JSONL streamed", () => {
  const src = read(FILES.resultService);
  assert.ok(src.includes("Readable.fromWeb"));
  assert.ok(src.includes("readline.createInterface"));
  assert.ok(src.includes("for await (const line of rl)"));
});

test("10) item-level userErrors stored", () => {
  const src = read(FILES.resultService);
  assert.ok(src.includes("shopifyUserErrors"));
  assert.ok(src.includes("failureMessage"));
  assert.ok(src.includes("SHOPIFY_USER_ERRORS"));
});

test("11) partial failure becomes PARTIAL_FAILED", () => {
  const src = read(FILES.verifyService);
  assert.ok(src.includes("OPERATION_LIFECYCLE_STATES.PARTIAL_FAILED"));
  assert.ok(src.includes("const finalStatus = failed > 0"));
});

test("12) retry failed-only retries failed targets only", () => {
  const src = read(FILES.retryService);
  assert.ok(src.includes("status: \"FAILED\""));
  assert.ok(src.includes("retryTargetIdentities"));
  assert.ok(src.includes("No failed targets found to retry."));
});

test("13) mirror patch/finalization only after verification path", () => {
  const verifySrc = read(FILES.verifyService);
  const legacySrc = read(FILES.legacyFinalizer);
  assert.ok(verifySrc.includes("schedulePostMutationMirrorReconciliation"));
  assert.ok(legacySrc.includes("LEGACY_BULK_FINALIZER_RETIRED"));
  assert.equal(legacySrc.includes("prisma.changeRecord.updateMany"), false);
  assert.equal(legacySrc.includes("prisma.product.upsert"), false);
});

test("14) no app completion before ingestion", () => {
  const ingestWorkerSrc = read(FILES.resultWorker);
  assert.ok(ingestWorkerSrc.includes("RESULT_INGESTION"));
  assert.ok(ingestWorkerSrc.includes("enqueueVerification"));
  assert.ok(ingestWorkerSrc.includes("executionState: OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS"));
  const verifySrc = read(FILES.verifyService);
  assert.ok(verifySrc.includes("OPERATION_LIFECYCLE_STATES.MIRROR_UPDATING"));
  assert.ok(verifySrc.includes("OPERATION_LIFECYCLE_STATES.COMPLETED"));
});
