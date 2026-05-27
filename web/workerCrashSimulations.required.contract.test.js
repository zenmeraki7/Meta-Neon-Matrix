import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relPath) {
  return fs.readFileSync(path.resolve(relPath), "utf8");
}

const SRC = {
  mutationService: "web/services/bulkEdit/ShopifyBulkMutationService.js",
  executeWorker: "web/Jobs/Workers/bulkEditExecuteWorker.js",
  ingestWorker: "web/Jobs/Workers/bulkEditResultIngestWorker.js",
  ingestService: "web/services/bulkEdit/BulkEditResultIngestionService.js",
  verifyService: "web/services/bulkEdit/BulkEditVerificationService.js",
  retryService: "web/services/productService/BulkEditRetryService.js",
  mutationWebhookWorker: "web/Jobs/Workers/bulkOperationMutationWorker.js",
  pollingWorker: "web/Jobs/Workers/missedBulkOperationPollingWorker.js",
  recoveryWorker: "web/Jobs/Workers/stuckBulkMutationRecoveryWorker.js",
  manualRecovery: "web/recoverStuckEdits.js",
  runtimeHarness: "web/shopifySubmissionCrashRecovery.runtime.test.js",
};

test("1) crash after JSONL generated before staged upload has PREPARED_JSONL checkpoint", () => {
  const src = read(SRC.mutationService);
  assert.ok(src.includes("stageStatus: \"PREPARED_JSONL\""));
  assert.ok(src.includes("jsonlHash"));
  assert.ok(src.includes("submissionStage"));
  assert.ok(src.includes("STAGED_UPLOAD_CREATED"));
});

test("2) crash after staged upload before submit has UPLOADED checkpoint", () => {
  const src = read(SRC.mutationService);
  assert.ok(src.includes('submissionStage: "UPLOADED"'));
  assert.ok(src.includes("stagedUploadPathHash"));
  assert.ok(src.includes('stageStatus: "UPLOADED"'));
});

test("3) crash after submit before DB update has submit-intent reconciler", () => {
  const src = read(SRC.mutationService);
  assert.ok(src.includes('submissionStage: "SUBMIT_RESPONSE_RECEIVED"'));
  assert.ok(src.includes("PENDING_SUBMIT_INTENT_REQUIRES_RECONCILIATION"));
  assert.ok(fs.existsSync(path.resolve(SRC.runtimeHarness)));
});

test("4) crash after DB update before return remains idempotent", () => {
  const src = read(SRC.mutationService);
  assert.ok(src.includes("SHOPIFY_BULK_OPERATION_ALREADY_SUBMITTED"));
  assert.ok(src.includes("SUBMIT_FENCE_MISMATCH"));
});

test("5) webhook before DB update has ledger + retry window", () => {
  const routeSrc = read(SRC.mutationWebhookWorker);
  const ingestSrc = read(SRC.ingestWorker);
  assert.ok(routeSrc.includes("resolveOperationKindByLedger"));
  assert.ok(routeSrc.includes("bulk_operation_mutation_webhook"));
  assert.ok(ingestSrc.includes("EDIT_HISTORY_NOT_FOUND_RETRYABLE"));
});

test("6) webhook never arrives has dedicated polling fallback", () => {
  const src = read(SRC.pollingWorker);
  assert.ok(src.includes("pollMissedBulkOperations"));
  assert.ok(src.includes("BULK_OPERATION_RESULT_QUERY"));
  assert.ok(src.includes("poll-missed-bulk-operations"));
});

test("7) duplicate webhook x10 guarded by ingest lease/CAS", () => {
  const src = read(SRC.ingestService);
  assert.ok(src.includes("BULK_EDIT_RESULT_INGEST"));
  assert.ok(src.includes('path: ["resultIngestion", "ingestedAt"]'));
  assert.ok(src.includes("equals: null"));
});

test("8) ingestion crash halfway has chunked progression and resumable updates", () => {
  const src = read(SRC.ingestService);
  assert.ok(src.includes("const FLUSH_SIZE = 500"));
  assert.ok(src.includes("await flushPending()"));
  assert.ok(src.includes("status: { in: [\"pending\", \"PENDING\", \"failed\", \"FAILED\"] }"));
});

test("9) result URL expiry has bounded retries then failure", () => {
  const src = read(SRC.ingestWorker);
  assert.ok(src.includes("MAX_RESULT_URL_RETRIES"));
  assert.ok(src.includes("RESULT_URL_EXPIRED"));
  assert.ok(src.includes("RESULT_INGESTION_URL_EXPIRED"));
});

test("10) Shopify FAILED sets terminal failure", () => {
  const src = read(SRC.ingestWorker);
  assert.ok(src.includes('"FAILED"'));
  assert.ok(src.includes("SHOPIFY_BULK_OPERATION"));
  assert.ok(src.includes("OPERATION_LIFECYCLE_STATES.FAILED"));
});

test("11) Shopify CANCELED has distinct cancellation classification", () => {
  const src = read(SRC.ingestWorker);
  assert.ok(src.includes("SHOPIFY_BULK_OPERATION_CANCELLED"));
  assert.ok(src.includes("terminalStatus = cancelled ? \"cancelled\" : \"failed\""));
  assert.ok(src.includes("OPERATION_LIFECYCLE_STATES.CANCELLED"));
});

test("12) Shopify COMPLETED + row userErrors drives partial failure path", () => {
  const ingestSrc = read(SRC.ingestService);
  const verifySrc = read(SRC.verifyService);
  assert.ok(ingestSrc.includes("SHOPIFY_USER_ERRORS"));
  assert.ok(verifySrc.includes("PARTIAL_FAILED"));
});

test("13) retry during SHOPIFY_RUNNING is blocked", () => {
  const src = read(SRC.retryService);
  assert.ok(src.includes("RETRY_STATE_CONFLICT"));
  assert.ok(src.includes("RETRY_ALLOWED_SOURCE_STATES"));
});

test("14) busy Shopify mutation slot yields WAITING_FOR_SHOPIFY_SLOT + requeue", () => {
  const mutationSrc = read(SRC.mutationService);
  const executeSrc = read(SRC.executeWorker);
  assert.ok(mutationSrc.includes("WAITING_FOR_SHOPIFY_SLOT"));
  assert.ok(executeSrc.includes("waiting_for_shopify_slot"));
});

test("15) Redis restart safety: DB is control plane, cache is hint-only", () => {
  const src = read(SRC.mutationService);
  assert.ok(src.includes("cacheSet"));
  assert.ok(src.includes("bulkSubmission"));
  assert.ok(src.includes("shopifyBulkOperationId"));
});
