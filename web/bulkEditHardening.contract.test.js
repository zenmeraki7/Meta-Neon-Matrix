import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relPath) {
  return fs.readFileSync(path.resolve(relPath), "utf8");
}

test("result ingestion uses lease plus CAS guard before terminal counter write", () => {
  const source = read("web/services/bulkEdit/BulkEditResultIngestionService.js");
  assert.ok(source.includes('acquireOperationLease'));
  assert.ok(source.includes('namespace: "BULK_EDIT_RESULT_INGEST"'));
  assert.ok(source.includes('path: ["resultIngestion", "ingestedAt"]'));
  assert.ok(source.includes('equals: null'));
  assert.ok(source.includes('processedCount: {'));
  assert.ok(source.includes('increment: successCount'));
  const normalizeStart = source.indexOf("function normalizeTargetIdentity");
  const normalizeEnd = source.indexOf("function extractRowResult");
  const normalizeBlock = source.slice(normalizeStart, normalizeEnd);
  assert.equal(normalizeBlock.includes("|| row?.id"), false);
  assert.equal(normalizeBlock.includes("|| row?.product?.id"), false);
});

test("verification bounds high-risk verification and validates tuple semantics", () => {
  const source = read("web/services/bulkEdit/BulkEditVerificationService.js");
  assert.ok(source.includes("function requiresFullVerification(history)"));
  const configuredIndex = source.indexOf("const configured = String(history?.batch?.verificationMode");
  const fullIndex = source.indexOf("if (requiresFullVerification(history)) return VERIFY_MODES.FULL");
  assert.ok(configuredIndex > -1 && fullIndex > -1 && configuredIndex < fullIndex);
  assert.ok(source.includes("MAX_VERIFICATION_ROWS_PER_RUN"));
  assert.equal(source.includes("verifyRows.push(row)"), false);
  assert.ok(source.includes("completionBlockedByCoverage"));
  assert.ok(source.includes("fullCoverageAchieved"));
  assert.ok(source.includes("verificationTargetCount"));
  assert.ok(source.includes('inventoryLevelChanges'));
  assert.ok(source.includes('metafieldChanges'));
  assert.ok(source.includes('tupleKey = `${variantId}::${locationId}`'));
  assert.ok(source.includes('tupleKey = `${ownerId}::${namespace}::${key}::${type}`'));
  assert.ok(source.includes("fetchInventoryLevelsByTupleFromShopify"));
  assert.ok(source.includes("fetchMetafieldsByTupleFromShopify"));
  assert.equal(source.includes("prisma.inventoryLevelMirror.findMany"), false);
  assert.equal(source.includes("prisma.metafieldMirror.findMany"), false);
});

test("stuck recovery worker does not synthesize COMPLETED status on ingest re-enqueue", () => {
  const source = read("web/Jobs/Workers/stuckBulkMutationRecoveryWorker.js");
  assert.ok(!source.includes('status: "COMPLETED"'));
  assert.ok(source.includes('addbulkEditResultIngestJob'));
  assert.ok(source.includes('addbulkUndoResultIngestJob'));
});

test("manual stuck recovery script does not synthesize COMPLETED status", () => {
  const source = read("web/recoverStuckEdits.js");
  assert.ok(!source.includes('status: "COMPLETED"'));
});

test("scheduled worker re-checks entitlement and mirror safety at runtime and blocks when unsafe", () => {
  const source = read("web/Jobs/Workers/scheduledEditWorker.js");
  assert.ok(source.includes("loadAuthoritativeSubscriptionForShop"));
  assert.ok(source.includes("getPlanMaxBulkEditTargets"));
  assert.ok(source.includes("assertMirrorSafeForTargeting"));
  assert.ok(source.includes("SCHEDULED_EDIT_ENTITLEMENT_BLOCKED"));
  assert.ok(source.includes("SCHEDULED_EDIT_MIRROR_UNSAFE"));
});

test("execute worker persists and verifies execute lease fencing metadata", () => {
  const source = read("web/Jobs/Workers/bulkEditExecuteWorker.js");
  assert.ok(source.includes('namespace: "BULK_EDIT_EXECUTE"'));
  assert.ok(source.includes("acquireOperationLease"));
  assert.ok(source.includes("assertOperationLeaseOwnership"));
  assert.ok(source.includes("executeLeaseFencingToken"));
  assert.ok(source.includes("executeLeaseOwnerId"));
});

test("pipeline target.freeze acquires TARGET_FREEZE lease and enforces state/cancel guards", () => {
  const source = read("web/Jobs/Workers/bulkEditPipelineWorker.js");
  assert.ok(source.includes('namespace: "TARGET_FREEZE"'));
  assert.ok(source.includes("TARGET_FREEZE_LEASE_CONFLICT"));
  assert.ok(source.includes("OPERATION_CANCEL_REQUESTED"));
  assert.ok(source.includes("PIPELINE_STATE_CONFLICT"));
});

test("scheduled worker uses scheduled-run idempotency lock per history and schedule", () => {
  const source = read("web/Jobs/Workers/scheduledEditWorker.js");
  assert.ok(source.includes("scheduled-run-lock:"));
  assert.ok(source.includes("scheduled_run_lock_conflict"));
  assert.ok(source.includes("acquireScheduledRunLock"));
});

test("stuck recovery worker uses per-history cooldown dedupe key", () => {
  const source = read("web/Jobs/Workers/stuckBulkMutationRecoveryWorker.js");
  assert.ok(source.includes("stuck-recovery-cooldown:"));
  assert.ok(source.includes("RECOVERY_COOLDOWN_MS"));
  assert.ok(source.includes('connection.set('));
  assert.ok(source.includes("bulkOperationId"));
});

test("execute submit persists submission intent and reconciles from existing submissions", () => {
  const source = read("web/services/bulkEdit/ShopifyBulkMutationService.js");
  assert.ok(source.includes("shopifySubmissionIntent"));
  assert.ok(source.includes("buildSubmissionIntent"));
  assert.ok(source.includes("const existingSubmission = await db.bulkSubmission.findFirst"));
  assert.ok(source.includes("submissionStage: \"STAGED_UPLOAD_CREATED\""));
  assert.ok(source.includes("submissionStage: \"UPLOADED\""));
  assert.ok(source.includes("submissionStage: \"SUBMIT_RESPONSE_RECEIVED\""));
  assert.ok(source.includes("stageStatus: \"PENDING_SUBMIT\""));
  assert.ok(source.includes("stageStatus: \"STAGED_UPLOAD_CREATED\""));
  assert.ok(source.includes("stageStatus: \"UPLOADED\""));
  assert.ok(source.includes("stageStatus: \"SUBMIT_RESPONSE_RECEIVED\""));
  assert.ok(source.includes("const finalizeResult = await db.$transaction"));
  assert.ok(source.includes("SHOPIFY_SUBMISSION_FINALIZE_CONFLICT"));
  assert.ok(source.includes("SUBMIT_FENCE_MISMATCH"));
  assert.ok(source.includes("reconciled: true"));
  assert.ok(source.includes("pendingIntent: true"));
  assert.equal(source.includes("PENDING_SUBMIT_INTENT_REQUIRES_RECONCILIATION"), false);
  assert.ok(source.includes("const slot = await this.assertNoActiveMutationOperation();"));
});

test("bulk operation mutation webhook routing prefers durable submission ledger", () => {
  const source = read("web/Jobs/Workers/bulkOperationMutationWorker.js");
  assert.ok(source.includes("resolveOperationKindByLedger"));
  assert.ok(source.includes("db.bulkSubmission.findUnique"));
  assert.ok(source.includes("routedBy: ledgerResolution.source"));
});

test("shopify bulk mutation submission avoids stale batch merges and lazy imports", () => {
  const source = read("web/services/bulkEdit/ShopifyBulkMutationService.js");
  assert.equal(source.includes("await import("), false);
  assert.equal(source.includes("async getDb()"), false);
  assert.equal(source.includes("resolveUploadToShopifyStagedTarget"), false);
  assert.equal(source.includes("resolveStageProgressUpsert"), false);
  assert.equal(source.includes("mergeBatch(history.batch"), false);
  assert.ok(source.includes("let batchState = history.batch"));
  assert.ok(source.includes("rememberBatch(mergeCurrentBatch({"));
});

test("shopify bulk mutation submission keeps deterministic and bounded submission semantics", () => {
  const source = read("web/services/bulkEdit/ShopifyBulkMutationService.js");
  assert.equal(source.includes("batchId || Date.now()"), false);
  assert.equal(source.includes("text.split(\"\\n\")"), false);
  assert.equal(source.includes("async submitBulkMutation(args)"), false);
  assert.ok(source.includes("text.split(/\\r?\\n/)"));
  assert.ok(source.includes("ADAPTIVE_BATCH_SIZE_MIN"));
  assert.ok(source.includes("ADAPTIVE_BATCH_SIZE_MAX"));
  assert.ok(source.includes("if (bulkErrors.length && !bulkOperation.id)"));
  assert.ok(source.includes("const stagedUploadPathHash = hashValue(stagedUploadPath);"));
});

test("bulk operation mutation worker routes all mutation statuses through ingest orchestrator only", () => {
  const source = read("web/Jobs/Workers/bulkOperationMutationWorker.js");
  assert.ok(source.includes('if (type === "MUTATION")'));
  assert.equal(
    source.includes("handleProductEditOperation"),
    false,
    "mutation webhook worker must not invoke legacy bulk finalizer",
  );
  assert.equal(
    source.includes('status === "COMPLETED"'),
    false,
    "mutation webhook routing must not special-case COMPLETED in worker path",
  );
  assert.ok(source.includes("addbulkEditResultIngestJob"));
});
