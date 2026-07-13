import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildPublicApiErrorResponse } from "./utils/publicApiError.js";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

test("History exposes one authenticated authoritative undo POST and tenant status route", () => {
  const historyRoutes = read("./routes/HistoryRoutes.js");
  const productRoutes = read("./routes/productRoutes.js");
  assert.match(
    historyRoutes,
    /router\.post\([\s\S]*"\/:historyId\/undo"[\s\S]*validateSession[\s\S]*requestHistoryUndo/
  );
  assert.match(
    historyRoutes,
    /"\/undo\/:undoExecutionId\/status"[\s\S]*validateSession/
  );
  assert.doesNotMatch(productRoutes, /undo-edit/);
});

test("history list selects undo evidence only from target snapshots", () => {
  const service = read("./services/historyService/historyService.js");
  const listQuery = service.match(
    /const records = await db\.editHistory\.findMany\(\{([\s\S]*?)\n\s*\}\);\n\n\s*const hasNextPage/
  );

  assert.ok(
    listQuery,
    "expected the EditHistory list query to remain discoverable"
  );
  assert.doesNotMatch(
    listQuery[1],
    /undoStatus:\s*true|undoPayload:\s*true|undoErrorCode:\s*true|undoErrorMessage:\s*true|undoneAt:\s*true/
  );
  assert.match(
    service,
    /db\.targetSnapshotItem\.findMany\([\s\S]*undoPayload:\s*true/
  );
});

test("undo claim is a serializable atomic execution, command, history and outbox write", () => {
  const service = read("./services/productService/productBulkUndoService.js");
  assert.match(service, /db\.\$transaction\([\s\S]*async \(tx\) =>/);
  assert.match(service, /isolationLevel: "Serializable"/);
  assert.match(service, /tx\.undoOperation\.create/);
  assert.match(service, /tx\.undoCommand\.create/);
  assert.match(service, /tx\.outboxEvent\.create/);
  assert.match(service, /tx\.editHistory\.updateMany/);
  assert.doesNotMatch(service, /addbulkUndoJob\(/);
  assert.match(service, /error\?\.code === "P2002"/);
  assert.match(service, /error\?\.code === "P2034"/);
});

test("undo claim accepts only server-owned successful items with complete snapshots", () => {
  const service = read("./services/productService/productBulkUndoService.js");
  assert.match(service, /shop: this\.session\.shop/);
  assert.match(service, /status: \{ in: SUCCESSFUL_CHANGE_STATUSES \}/);
  assert.match(service, /snapshotCount !== undoableTargetKeys\.length/);
  assert.match(service, /UNDO_SNAPSHOTS_INCOMPLETE/);
  assert.match(service, /CSV_CREATE_UNDO_NOT_SUPPORTED/);
  assert.match(service, /containsCsvCreates/);
  assert.doesNotMatch(
    service,
    /options\?\.(beforeValue|afterValue|productIds|variantIds)/
  );
});

test("undo eligibility errors are not collapsed into a route-level 404", () => {
  const noTargets = Object.assign(new Error("No applied items can be undone"), {
    code: "UNDO_ELIGIBLE_TARGETS_NOT_FOUND",
  });
  const csvCreate = Object.assign(new Error("Unsafe create undo"), {
    code: "CSV_CREATE_UNDO_NOT_SUPPORTED",
  });

  const noTargetsResponse = buildPublicApiErrorResponse(noTargets);
  const csvCreateResponse = buildPublicApiErrorResponse(csvCreate);

  assert.equal(noTargetsResponse.statusCode, 409);
  assert.equal(noTargetsResponse.body.code, "UNDO_ELIGIBLE_TARGETS_NOT_FOUND");
  assert.equal(csvCreateResponse.statusCode, 409);
  assert.equal(csvCreateResponse.body.code, "CSV_CREATE_UNDO_NOT_SUPPORTED");
});

test("historical CSV-created products are migrated to fail-closed undo state", () => {
  const migration = read(
    "./prisma/migrations/20260713150000_disable_unsafe_csv_create_undo/migration.sql"
  );
  assert.match(migration, /change\."options"->>'csvCreate'/);
  assert.match(migration, /jsonb_set/);
  assert.match(migration, /'\{allowed\}'/);
  assert.match(migration, /"UndoOperation"/);
});

test("outbox dispatcher publishes a deterministic BullMQ undo job and recovers stale claims", () => {
  const dispatcher = read("./workers/outboxDispatcherWorker.js");
  const queue = read("./Jobs/Queues/bulkUndoJob.js");
  assert.match(dispatcher, /event\.eventType === "UNDO_REQUESTED"/);
  assert.match(dispatcher, /const undoJob = await addbulkUndoJob\(payload\)/);
  assert.doesNotMatch(dispatcher, /jobId: `undo:/);
  assert.match(queue, /data\.undoExecutionId \|\| data\.historyId/);
  assert.match(queue, /buildUndoExecuteJobId/);
  assert.match(dispatcher, /status: OUTBOX_STATUS\.DISPATCHING/);
  assert.match(dispatcher, /updatedAt: \{ lt: staleBefore \}/);
  assert.match(dispatcher, /status: OUTBOX_STATUS\.DISPATCHED/);
  assert.match(dispatcher, /status: OUTBOX_STATUS\.PENDING/);
});

test("History client posts only the full path id, deduplicates clicks and polls boundedly", () => {
  const table = read("./frontend/Domain/History/components/HistoryTable.jsx");
  const service = read("./frontend/Domain/History/services/historyService.js");
  const modal = read(
    "./frontend/Domain/products/edit/components/AlertUndo.jsx"
  );
  assert.match(service, /unifiedApiRequest\(/);
  assert.match(table, /useAuthenticatedFetch\(\)/);
  assert.match(service, /authenticatedFetch/);
  assert.match(
    service,
    /`\/api\/history\/\$\{encodeURIComponent\(immutableId\)\}\/undo`/
  );
  assert.match(service, /confirmationOperationId/);
  assert.doesNotMatch(table, /api\/products\/undo-edit/);
  assert.match(
    table,
    /if \(undoRequestRef\.current\) return undoRequestRef\.current/
  );
  assert.match(table, /attempt < 12/);
  assert.match(table, /pollingAbortRef\.current\?\.abort\(\)/);
  assert.match(modal, /Boolean\(historyId\)/);
  assert.match(modal, /SESSION_TOKEN_ACQUISITION_FAILED/);
  assert.match(table, /getBrowserScheduleTimezone\(\) \|\| "Asia\/Kolkata"/);
  assert.match(modal, /displayTimezone/);
});

test("embedded auth uses current App Bridge and fresh tokens without v3 mixing", () => {
  const provider = read(
    "./frontend/components/providers/AppBridgeProvider.jsx"
  );
  const helper = read("./frontend/api/shopifyAuthenticatedFetch.js");
  assert.match(provider, /useAppBridge/);
  assert.match(provider, /getFreshShopifySessionToken\(shopify\)/);
  assert.doesNotMatch(provider, /@shopify\/app-bridge\/utilities|createApp/);
  assert.match(helper, /shopify\.idToken\(\)/);
  assert.match(helper, /firstResponse\.status !== 401/);
  assert.match(helper, /return requestOnce\(uri, options\)/);
});

test("request ownership, duplicate submission and queued replay remain safe", () => {
  const service = read("./services/productService/productBulkUndoService.js");
  const repository = read("./repositories/bulkUndoExecutionRepository.js");
  const table = read("./frontend/Domain/History/components/HistoryTable.jsx");
  const controller = read("./controllers/historyUndoController.js");
  assert.match(
    service,
    /where: \{ id: requestedHistoryId, shop: this\.session\.shop \}/
  );
  assert.match(
    table,
    /if \(undoRequestRef\.current\) return undoRequestRef\.current/
  );
  assert.match(
    service,
    /return toUndoResponse\(existing, \{ idempotent: true \}\)/
  );
  assert.match(controller, /return res\.status\(202\)\.json\(result\)/);
  assert.match(controller, /confirmationOperationId/);
  assert.match(repository, /updatedAt: current\.updatedAt/);
  assert.match(repository, /if \(undo\.allowed !== true\)/);
  assert.match(repository, /error\.code = "UNDO_NOT_ALLOWED"/);
  assert.doesNotMatch(repository, /path: \["executionIdentity"\]/);
  assert.doesNotMatch(repository, /path: \["state"\]/);
});

test("status endpoint is tenant scoped and does not expose snapshots", () => {
  const controller = read("./controllers/historyUndoController.js");
  assert.match(
    controller,
    /where: \{ id: undoExecutionId, shop: session\.shop \}/
  );
  assert.match(controller, /remaining: Math\.max/);
  assert.doesNotMatch(
    controller,
    /beforeValues|afterValues|commandJson|payloadJson/
  );
});

test("undo paging uses a ChangeRecord cursor and webhook ingestion uses scalar fencing", () => {
  const worker = read("./Jobs/Workers/bulkUndoWorker.js");
  const repository = read("./repositories/bulkUndoExecutionRepository.js");
  const ingestion = read("./services/undo/UndoResultIngestionService.js");
  assert.match(worker, /const cursorId = undo\.lastChangeRecordId \|\| null/);
  assert.match(repository, /lastChangeRecordId: lastProductId/);
  assert.doesNotMatch(worker, /const cursorId = batch\.lastProductId/);
  assert.match(ingestion, /bulkOperationId: String\(bulkOperationId\)/);
  assert.match(ingestion, /updatedAt: history\.updatedAt/);
  assert.doesNotMatch(ingestion, /path: \["bulkOperationId"\]/);
  assert.doesNotMatch(ingestion, /path: \["state"\]/);
  assert.match(ingestion, /errorCode: null/);
  assert.match(ingestion, /errorMessage: null/);
});

test("failed undo recovery is audited, zero-progress only, and outbox-driven", () => {
  const repository = read("./repositories/bulkUndoExecutionRepository.js");
  assert.match(repository, /export async function recoverFailedUndoExecution/);
  assert.match(repository, /operation\.processedCount !== 0/);
  assert.match(repository, /operation\.bulkOperationId/);
  assert.match(repository, /UNDO_RECOVERY_EXECUTION_IDENTITY_MISMATCH/);
  assert.match(repository, /tx\.bulkEditRecoveryAudit\.create/);
  assert.match(repository, /eventType: "UNDO_REQUESTED"/);
  assert.match(repository, /source: "manual_undo_recovery"/);
  assert.match(repository, /isolationLevel: "Serializable"/);
  assert.match(
    repository,
    /export async function reopenFalseCompletedUndoExecution/
  );
  assert.match(repository, /FALSE_COMPLETION_EVIDENCE_REQUIRED/);
  assert.match(repository, /UNDO_FALSE_COMPLETION_REOPEN/);
});

test("undo completion requires item-result ingestion and live restored-state verification", () => {
  const service = read("./services/undo/UndoResultIngestionService.js");
  const undoService = read(
    "./services/productService/productBulkUndoService.js"
  );
  const worker = read("./Jobs/Workers/bulkUndoResultIngestWorker.js");
  assert.match(service, /inspectUndoResultJsonl/);
  assert.match(service, /UNDO_SHOPIFY_ITEM_FAILURE/);
  assert.match(service, /verifyUndoRestored/);
  assert.match(service, /applyVerifiedUndoToMirror/);
  assert.match(worker, /resultUrl: job\.data\?\.url/);
  assert.match(undoService, /trustedProductSet/);
  assert.match(undoService, /selectedOptions/);
});
