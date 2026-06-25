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
  assert.ok(source.includes('equals: Prisma.DbNull'));
  assert.ok(source.includes('processedCount: {'));
  assert.ok(source.includes('increment: successCount'));
  const normalizeStart = source.indexOf("function normalizeTargetIdentity");
  const normalizeEnd = source.indexOf("function extractRowResult");
  const normalizeBlock = source.slice(normalizeStart, normalizeEnd);
  assert.equal(normalizeBlock.includes("|| row?.id"), false);
  assert.equal(normalizeBlock.includes("|| row?.product?.id"), false);
});

test("verification forces FULL mode for variant/inventory/metafield targets and validates tuple semantics", () => {
  const source = read("web/services/bulkEdit/BulkEditVerificationService.js");
  assert.ok(source.includes("function requiresFullVerification(history)"));
  assert.ok(source.includes('if (requiresFullVerification(history)) return VERIFY_MODES.FULL'));
  assert.ok(source.includes("deterministicFullRequired"));
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

test("scheduled edit creation requires approved preview contract and rejects legacy mutable payloads", () => {
  const normalizer = read("web/normalizers/productBulkEditCommandNormalizer.js");
  const useCase = read("web/useCases/productBulkEditUseCases.js");
  const service = read("web/services/productService/ScheduledEditService.js");
  const modal = read("web/frontend/Domain/products/edit/components/ScheduleEdit.jsx");

  assert.ok(normalizer.includes("LEGACY_SCHEDULE_PAYLOAD_FORBIDDEN"));
  assert.ok(normalizer.includes("assertNoLegacySchedulePayload"));
  assert.ok(useCase.includes("STATIC_SCHEDULE_FREEZE_REQUIRED"));
  assert.ok(useCase.includes("APPROVED_TARGET_COUNT_REQUIRED"));
  assert.ok(service.includes("findPreviewContractRecord"));
  assert.ok(service.includes("APPROVED_TARGET_COUNT_MISMATCH"));
  assert.ok(service.includes("PREVIEW_TARGET_COUNT_MISMATCH"));
  assert.ok(service.includes("SCHEDULE_CONFIRMATION_REQUIRED"));
  assert.ok(modal.includes('freezeMode: "STATIC_AT_SCHEDULE_CREATE"'));
  assert.equal(modal.includes("filterParams"), false);
  assert.equal(modal.includes("buildFilterAstFromLegacyFilters"), false);
});

test("paid feature denial is returned as an upgrade requirement and schedule UI offers pricing", () => {
  const middleware = read("web/middleware/subscriptionMiddleware.js");
  const routes = read("web/routes/productRoutes.js");
  const publicErrors = read("web/utils/publicApiError.js");
  const modal = read("web/frontend/Domain/products/edit/components/ScheduleEdit.jsx");

  assert.ok(middleware.includes('code: "UPGRADE_REQUIRED"'));
  assert.ok(middleware.includes("requireScheduledEditPlanMiddleware"));
  assert.ok(middleware.includes("SCHEDULED_EDITS_UPGRADE_MESSAGE"));
  assert.ok(routes.includes("requireScheduledEditPlanMiddleware"));
  assert.ok(publicErrors.includes('UPGRADE_REQUIRED: "This feature requires an active paid plan."'));
  assert.ok(publicErrors.includes('feature: String(details.feature || "scheduled_edits")'));
  assert.ok(modal.includes('errorCode === "UPGRADE_REQUIRED"'));
  assert.ok(modal.includes('onAction: () => navigate(resolvedBillingUrl)'));
  assert.ok(modal.includes('defaultValue: "Scheduled edit time must be in the future."'));
  assert.equal(modal.includes('throw new Error(\n          t("scheduledTimeMustBeFuture"'), false);
});

test("history changes bypass stale empty cache and invalidate after ingestion and verification", () => {
  const history = read("web/services/historyService/historyService.js");
  const ingestion = read("web/services/bulkEdit/BulkEditResultIngestionService.js");
  const verification = read("web/services/bulkEdit/BulkEditVerificationService.js");

  assert.ok(history.includes("cachedTotalCount > 0 || cacheData?.changes?.length > 0"));
  assert.ok(history.includes("batch.resultIngestion.ingestedAt"));
  assert.ok(history.includes("row.beforeValues?.productTitle || row.targetKey"));
  assert.ok(ingestion.includes("clearKeyCaches(`${shop}:historyChanges:${historyId}:`)"));
  assert.ok(verification.includes("clearKeyCaches(`${shop}:historyChanges:${historyId}:`)"));
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
  assert.ok(source.includes('"stuck-bulk-edit-result-ingest"'));
  assert.ok(source.includes("joinSafeJobId"));
  assert.ok(source.includes("bulkOperationId"));
});

test("execute submit persists submission intent and reconciles from existing submissions", () => {
  const source = read("web/services/bulkEdit/ShopifyBulkMutationService.js");
  assert.ok(source.includes("shopifySubmissionIntent"));
  assert.ok(source.includes("buildSubmissionIntent"));
  assert.ok(source.includes("const existingSubmission = await db.bulkSubmission.findFirst"));
  assert.ok(source.includes("PENDING_SUBMIT_INTENT_REQUIRES_RECONCILIATION"));
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
});

test("bulk operation mutation webhook routing prefers durable submission ledger", () => {
  const source = read("web/Jobs/Workers/bulkOperationMutationWorker.js");
  assert.ok(source.includes("resolveOperationKindByLedger"));
  assert.ok(source.includes("prisma.bulkSubmission.findUnique"));
  assert.ok(source.includes("routedBy: ledgerResolution.source"));
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
