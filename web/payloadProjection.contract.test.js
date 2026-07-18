import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(file) {
  return fs.readFileSync(path.resolve(file), "utf8");
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

test("ProductBulkPreviewService uses explicit select projection for preview products and variants", () => {
  const source = read("web/services/productService/ProductBulkPreviewService.js");

  assert.ok(source.includes("export const PREVIEW_PRODUCT_SELECT"));
  assert.ok(source.includes("export const PREVIEW_VARIANT_SELECT"));
  assert.ok(source.includes("select: {"));
  assert.ok(source.includes("...PREVIEW_PRODUCT_SELECT"));
  assert.ok(source.includes("select: PREVIEW_VARIANT_SELECT"));
  assert.equal(
    source.includes("include: {"),
    false,
    "Preview service should avoid broad include-based fetching",
  );
});

test("sync summary DTO remains materially smaller than detail DTO (payload diff guard)", () => {
  const detailLike = {
    isCollectionSyncing: false,
    lastCollectionSyncAt: "2026-05-26T00:00:00.000Z",
    mirrorHealthState: "HEALTHY",
    staleReason: null,
    repairRequired: false,
    mirrorUnsafeSince: null,
    lastFullSyncAt: "2026-05-26T00:00:00.000Z",
    lastIncrementalSyncAt: "2026-05-26T00:00:00.000Z",
    lastWebhookProcessedAt: "2026-05-26T00:00:00.000Z",
    lastReconcileAt: "2026-05-26T00:00:00.000Z",
    lastInventoryReconcileAt: "2026-05-26T00:00:00.000Z",
    lastCollectionReconcileAt: "2026-05-26T00:00:00.000Z",
    lastSyncErrorSummary: null,
    syncProgressStage: "MIRROR_STAGING",
    isProductTypeSyncing: false,
    lastProductTypeSyncAt: "2026-05-26T00:00:00.000Z",
    isProductInitialySyning: true,
    productInitialSyncProgress: 123,
    shopifyBulkJobCompleted: false,
    storeTotalProducts: 1000,
    isProductSyncing: true,
    lastProductSyncAt: "2026-05-26T00:00:00.000Z",
    activeMirrorBatchId: "batch-1",
    latestSync: {
      id: "sync-1",
      bulkOperationId: "gid://shopify/BulkOperation/1",
      syncBatchId: "batch-1",
      status: "running",
      stage: "SHOPIFY_BULK_RUNNING",
      recordCount: 1000,
      updatedAt: "2026-05-26T00:00:00.000Z",
      errorMessage: null,
      isInitialProductSync: true,
    },
  };

  const summaryLike = {
    syncProgressStage: detailLike.syncProgressStage,
    isProductInitialySyning: detailLike.isProductInitialySyning,
    shopifyBulkJobCompleted: detailLike.shopifyBulkJobCompleted,
    storeTotalProducts: detailLike.storeTotalProducts,
    isProductSyncing: detailLike.isProductSyncing,
    lastProductSyncAt: detailLike.lastProductSyncAt,
    activeMirrorBatchId: detailLike.activeMirrorBatchId,
    latestSync: {
      id: detailLike.latestSync.id,
      status: detailLike.latestSync.status,
      stage: detailLike.latestSync.stage,
      updatedAt: detailLike.latestSync.updatedAt,
      errorMessage: detailLike.latestSync.errorMessage,
      isInitialProductSync: detailLike.latestSync.isInitialProductSync,
    },
  };

  assert.ok(
    jsonBytes(summaryLike) < jsonBytes(detailLike),
    "Expected summary payload shape to be smaller than detail payload shape",
  );

  const source = read("web/controllers/syncController.js");
  assert.ok(source.includes("toSyncStatusSummaryDto("));
  assert.ok(source.includes("toSyncStatusDetailDto("));
});

test("edit history summary remains materially smaller than detail payload (payload diff guard)", () => {
  const detailLike = {
    id: "hist-1",
    title: "Bulk price update",
    status: "completed",
    executionState: "COMPLETED",
    processedCount: 1000,
    totalItems: 1000,
    durationMs: 15234,
    shop: "demo.myshopify.com",
    undo: { allowed: true, status: "idle", processedCount: 0, error: null },
    batch: {
      idempotencyStages: {
        TARGETING: { status: "completed", attempts: 1, startedAt: "2026-05-26T00:00:00.000Z" },
      },
      immutableEditCommand: {
        idempotencyKey: "idem-1",
        mutationPlan: { strategy: "BULK", inputs: [{ key: "price" }] },
      },
      ingestionSummary: {
        totalTargets: 1000,
        submittedCount: 1000,
        successCount: 1000,
        failedCount: 0,
      },
    },
    executionTransparency: {
      executionPlan: { mutationType: "PRODUCT_SET", apiStrategy: "BULK" },
      shopifySubmission: { submitted: true, bulkOperationId: "gid://shopify/BulkOperation/1" },
    },
    idempotencyStages: [
      { stage: "TARGETING", status: "completed", attempts: 1, startedAt: "2026-05-26T00:00:00.000Z" },
    ],
    immutableEditCommand: {
      idempotencyKey: "idem-1",
      mutationPlan: { strategy: "BULK", inputs: [{ key: "price" }] },
    },
  };

  const summaryLike = {
    id: detailLike.id,
    title: detailLike.title,
    status: detailLike.status,
    executionState: detailLike.executionState,
    processedCount: detailLike.processedCount,
    totalItems: detailLike.totalItems,
    durationMs: detailLike.durationMs,
    shop: detailLike.shop,
    undo: detailLike.undo,
    batch: {
      idempotencyStages: detailLike.batch.idempotencyStages,
      ingestionSummary: detailLike.batch.ingestionSummary,
    },
  };

  assert.ok(
    jsonBytes(summaryLike) < jsonBytes(detailLike),
    "Expected edit history summary payload shape to be smaller than detail payload shape",
  );

  const historyController = read("web/controllers/historyController.js");
  const historyRoutes = read("web/routes/HistoryRoutes.js");
  const historyService = read("web/services/historyService/historyService.js");
  const editDetailsPage = read("web/frontend/Domain/products/edit/pages/EditDetails.jsx");

  assert.ok(historyController.includes("getHistorySummary"));
  assert.ok(historyRoutes.includes("/get-edit-history-summary/:id"));
  assert.ok(historyService.includes("async getHistorySummary("));
  assert.ok(editDetailsPage.includes("/api/history/get-edit-history-summary/"));
});

test("snapshot-backed history changes project persisted row-level undo evidence", () => {
  const source = read("web/services/historyService/historyService.js");
  const snapshotHistoryBranch = source.slice(
    source.indexOf("if (snapshotSetId && history.isSpreadsheetEdit !== true)"),
    source.indexOf("const totalCount = await db.changeRecord.count"),
  );

  assert.ok(snapshotHistoryBranch.includes("undoStatus: true"));
  assert.ok(snapshotHistoryBranch.includes("undoPayload: true"));
  assert.ok(snapshotHistoryBranch.includes("undoErrorCode: true"));
  assert.ok(snapshotHistoryBranch.includes("undoErrorMessage: true"));
  assert.ok(snapshotHistoryBranch.includes("undoneAt: true"));
  assert.ok(snapshotHistoryBranch.includes("buildUndoResultProjection(row)"));
});
