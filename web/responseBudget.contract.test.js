import test from "node:test";
import assert from "node:assert/strict";

import {
  RESPONSE_BUDGET_BYTES,
  computeJsonResponseSizeBytes,
  createResponseBudgetMiddleware,
  matchResponseBudget,
} from "./middleware/responseBudgetMiddleware.js";

function buildMockRes() {
  const headers = new Map();
  const state = {
    statusCode: 200,
    body: null,
  };

  return {
    state,
    headers,
    setHeader(key, value) {
      headers.set(String(key).toLowerCase(), String(value));
    },
    status(code) {
      state.statusCode = code;
      return this;
    },
    json(body) {
      state.body = body;
      return body;
    },
  };
}

test("response budgets are defined for all high-traffic read endpoints", () => {
  assert.ok(RESPONSE_BUDGET_BYTES["/api/products/get-all"] > 0);
  assert.ok(RESPONSE_BUDGET_BYTES["/api/products/edit-preview"] > 0);
  assert.ok(RESPONSE_BUDGET_BYTES["/api/history/get-shop-edithistory"] > 0);
  assert.ok(RESPONSE_BUDGET_BYTES["/api/history/get-edit-history-summary/:id"] > 0);
  assert.ok(RESPONSE_BUDGET_BYTES["/api/history/get-edit-history-details/:id"] > 0);
  assert.ok(RESPONSE_BUDGET_BYTES["/api/history/get-edit-history/changes/:id"] > 0);
  assert.ok(RESPONSE_BUDGET_BYTES["/api/history/get-shop-importhistory"] > 0);
  assert.ok(RESPONSE_BUDGET_BYTES["/api/history/export/list-summary"] > 0);
  assert.ok(RESPONSE_BUDGET_BYTES["/api/history/export/detail/:id"] > 0);
  assert.ok(RESPONSE_BUDGET_BYTES["/api/products/recurring/list-summary"] > 0);
  assert.ok(RESPONSE_BUDGET_BYTES["/api/products/recurring/detail/:id"] > 0);
  assert.ok(RESPONSE_BUDGET_BYTES["/api/sync/sync-status"] > 0);
  assert.ok(RESPONSE_BUDGET_BYTES["/api/sync/sync-status/summary"] > 0);
  assert.ok(RESPONSE_BUDGET_BYTES["/api/sync/sync-status/detail"] > 0);
  assert.ok(RESPONSE_BUDGET_BYTES["/api/sync/product-track"] > 0);
  assert.ok(RESPONSE_BUDGET_BYTES["/api/store/details"] > 0);
});

test("route matcher resolves parameterized detail routes", () => {
  const exportDetail = matchResponseBudget("/api/history/export/detail/exp_123");
  const recurringDetail = matchResponseBudget("/api/products/recurring/detail/rec_456");
  const editSummary = matchResponseBudget("/api/history/get-edit-history-summary/h_123");
  const editDetail = matchResponseBudget("/api/history/get-edit-history-details/h_123");
  const editChanges = matchResponseBudget("/api/history/get-edit-history/changes/h_123");
  assert.equal(exportDetail?.pattern, "/api/history/export/detail/:id");
  assert.equal(recurringDetail?.pattern, "/api/products/recurring/detail/:id");
  assert.equal(editSummary?.pattern, "/api/history/get-edit-history-summary/:id");
  assert.equal(editDetail?.pattern, "/api/history/get-edit-history-details/:id");
  assert.equal(editChanges?.pattern, "/api/history/get-edit-history/changes/:id");
});

test("budget middleware blocks oversized payloads when enforcement enabled", () => {
  const middleware = createResponseBudgetMiddleware({ enforce: true });
  const req = { path: "/api/history/export/list-summary", originalUrl: "/api/history/export/list-summary" };
  const res = buildMockRes();
  let nextCalled = false;

  middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);

  const overBudget = "x".repeat(RESPONSE_BUDGET_BYTES["/api/history/export/list-summary"] + 64);
  res.json({ success: true, data: overBudget });

  assert.equal(res.state.statusCode, 500);
  assert.equal(res.state.body?.code, "RESPONSE_BUDGET_EXCEEDED");
  assert.equal(
    Number(res.headers.get("x-response-budget-bytes")),
    RESPONSE_BUDGET_BYTES["/api/history/export/list-summary"],
  );
});

test("budget middleware preserves response under budget", () => {
  const middleware = createResponseBudgetMiddleware({ enforce: true });
  const req = { path: "/api/products/recurring/list-summary", originalUrl: "/api/products/recurring/list-summary" };
  const res = buildMockRes();

  middleware(req, res, () => {});

  const body = {
    success: true,
    data: Array.from({ length: 5 }, (_, i) => ({
      id: `rec_${i}`,
      title: `Rule ${i}`,
      status: "Active",
      frequency: "Daily",
    })),
  };
  res.json(body);

  assert.equal(res.state.statusCode, 200);
  assert.deepEqual(res.state.body, body);
  assert.ok(
    Number(res.headers.get("x-response-size-bytes")) <
      RESPONSE_BUDGET_BYTES["/api/products/recurring/list-summary"],
  );
});

test("computed JSON byte sizes stay within configured budgets for representative payloads", () => {
  const productListBody = {
    success: true,
    data: {
      count: 2500,
      products: Array.from({ length: 20 }, (_, index) => ({
        id: `gid://shopify/Product/${index + 1}`,
        title: `Product ${index + 1}`,
        handle: `product-${index + 1}`,
        status: "active",
        product_type: "Apparel",
        vendor: "Brand",
        updatedAt: "2026-05-26T10:00:00.000Z",
        variants: Array.from({ length: 3 }, (_, variantIndex) => ({
          id: `gid://shopify/ProductVariant/${index + 1}-${variantIndex + 1}`,
          title: `Variant ${variantIndex + 1}`,
          sku: `SKU-${index + 1}-${variantIndex + 1}`,
          price: "29.99",
        })),
      })),
      pageInfo: { hasNextPage: true, endCursor: "cursor_20" },
    },
  };
  const previewBody = {
    success: true,
    data: {
      total: 5000,
      products: Array.from({ length: 20 }, (_, index) => ({
        id: `gid://shopify/Product/${index + 1}`,
        title: `Preview Product ${index + 1}`,
        current: { price: "29.99", compareAtPrice: "39.99" },
        preview: { price: "24.99", compareAtPrice: "39.99" },
        variants: Array.from({ length: 3 }, (_, variantIndex) => ({
          id: `gid://shopify/ProductVariant/${index + 1}-${variantIndex + 1}`,
          title: `Variant ${variantIndex + 1}`,
          currentPrice: "29.99",
          previewPrice: "24.99",
        })),
      })),
      pageInfo: { hasNextPage: true, nextCursor: "cursor_20" },
    },
  };
  const historyListBody = {
    success: true,
    data: Array.from({ length: 20 }, (_, index) => ({
      id: `hist_${index}`,
      title: `Bulk edit ${index}`,
      status: "completed",
      processedCount: 250,
      totalItems: 250,
      updatedAt: "2026-05-26T10:00:00.000Z",
      primaryStatus: { key: "completed", label: "Completed" },
      progressSummary: { current: 250, total: 250, percent: 100, label: "250 / 250" },
      supportStatus: { executionState: "completed", failureStage: null },
    })),
    meta: { pageInfo: { hasNextPage: true, endCursor: "hist_20" }, total: 4000 },
  };
  const historySummaryBody = {
    success: true,
    data: {
      id: "hist_1",
      title: "Bulk price update",
      status: "processing",
      processedCount: 1200,
      totalItems: 5000,
      progressSummary: { current: 1200, total: 5000, percent: 24, label: "1200 / 5000" },
      supportStatus: { executionState: "awaiting_shopify", failureStage: null },
    },
  };
  const historyDetailBody = {
    success: true,
    data: {
      ...historySummaryBody.data,
      immutableEditCommand: { idempotencyKey: "idem-1", mutationPlan: { strategy: "BULK" } },
      idempotencyStages: Array.from({ length: 8 }, (_, index) => ({
        stage: `STAGE_${index + 1}`,
        status: "completed",
        attempts: 1,
      })),
      executionTransparency: {
        executionPlan: { mutationType: "PRODUCT_SET", apiStrategy: "BULK" },
        shopifySubmission: { submitted: true, shopifyBulkOperationId: "gid://shopify/BulkOperation/1" },
      },
    },
  };
  const historyChangesBody = {
    success: true,
    data: Array.from({ length: 10 }, (_, index) => ({
      id: `chg_${index}`,
      title: `Product ${index}`,
      status: "SUCCESS",
      productFieldChanges: [{ field: "price", oldValue: "29.99", newValue: "24.99" }],
      variantFieldChanges: [],
      createdAt: "2026-05-26T10:00:00.000Z",
    })),
    meta: { totalCount: 1000, pageInfo: { hasNextPage: true, endCursor: "chg_10" } },
  };
  const importListBody = {
    success: true,
    data: Array.from({ length: 10 }, (_, index) => ({
      id: `imp_${index}`,
      fileName: `import-${index}.csv`,
      status: "completed",
      totalRows: 1000,
      successCount: 998,
      failedCount: 2,
      createdAt: "2026-05-26T10:00:00.000Z",
    })),
    pageInfo: { hasNextPage: true, endCursor: "imp_10" },
    totalCount: 500,
  };
  const exportListBody = {
    success: true,
    data: Array.from({ length: 20 }, (_, index) => ({
      id: `exp_${index}`,
      filename: `export-${index}.csv`,
      type: "manual export",
      rawType: "manual export",
      status: "completed",
      processedCount: 250,
      targetSnapshotCount: 250,
      progressPercent: 100,
      createdAt: "2026-05-26T10:00:00.000Z",
      completedAt: "2026-05-26T10:05:00.000Z",
      downloadUrl: "https://cdn.example.com/export.csv",
      durationMs: 300000,
      error: null,
    })),
    meta: {
      pageInfo: {
        hasNextPage: true,
        hasPreviousPage: false,
        nextCursor: "exp_20",
        previousCursor: null,
      },
      totalCount: 200,
    },
  };
  const recurringListBody = {
    success: true,
    data: Array.from({ length: 20 }, (_, index) => ({
      id: `rec_${index}`,
      _id: `rec_${index}`,
      title: `Recurring ${index}`,
      status: "Active",
      statusKey: "ACTIVE",
      frequency: "Weekly",
      totalRuns: 10,
      successfulRuns: 9,
      totalFails: 1,
      createdAt: "2026-05-26T10:00:00.000Z",
      nextRunAt: "2026-05-27T10:00:00.000Z",
      lastRunAt: "2026-05-26T09:30:00.000Z",
      lastRunStatus: "SUCCESS",
    })),
    pageInfo: {
      hasNextPage: true,
      hasPreviousPage: false,
      nextCursor: "rec_20",
      previousCursor: null,
      endCursor: "rec_20",
    },
    totalCount: 100,
  };
  const syncSummaryBody = {
    success: true,
    syncStatus: {
      syncProgressStage: "SHOPIFY_BULK_RUNNING",
      isProductInitiallySyncing: true,
      hasCompletedShopifyBulkJob: false,
      storeTotalProducts: 5000,
      isProductSyncing: true,
      lastProductSyncAt: "2026-05-26T10:00:00.000Z",
      currentProductMirrorBatchId: "batch_1",
      latestSync: {
        id: "sync_1",
        status: "running",
        stage: "SHOPIFY_BULK_RUNNING",
        updatedAt: "2026-05-26T10:00:00.000Z",
        errorMessage: null,
        isInitialProductSync: true,
      },
    },
  };
  const syncDetailBody = {
    success: true,
    syncStatus: {
      ...syncSummaryBody.syncStatus,
      mirrorHealthState: "HEALTHY",
      staleReason: null,
      requiresMirrorRepair: false,
      lastFullSyncAt: "2026-05-26T09:00:00.000Z",
      lastIncrementalSyncAt: "2026-05-26T10:00:00.000Z",
      lastWebhookProcessedAt: "2026-05-26T10:00:00.000Z",
      lastReconcileAt: "2026-05-26T09:30:00.000Z",
      lastInventoryReconcileAt: "2026-05-26T09:45:00.000Z",
      lastCollectionReconcileAt: "2026-05-26T09:50:00.000Z",
      lastSyncErrorSummary: null,
      isCollectionSyncing: false,
      isProductTypeSyncing: false,
    },
  };
  const syncTrackBody = {
    success: true,
    status: "syncing",
    stage: "SHOPIFY_BULK_RUNNING",
    totalProducts: 5000,
    processedProducts: 1200,
    progress: 24,
  };
  const storeDetailsBody = {
    success: true,
    data: {
      shop: "demo.myshopify.com",
      plan: "Pro",
      storeName: "Demo",
      timezone: "UTC",
      locale: "en",
      currency: "USD",
      features: { recurring: true, exports: true, bulkEdit: true },
    },
  };

  assert.ok(
    computeJsonResponseSizeBytes(productListBody) <=
      RESPONSE_BUDGET_BYTES["/api/products/get-all"],
    "Product list payload exceeded configured budget",
  );
  assert.ok(
    computeJsonResponseSizeBytes(previewBody) <=
      RESPONSE_BUDGET_BYTES["/api/products/edit-preview"],
    "Edit preview payload exceeded configured budget",
  );
  assert.ok(
    computeJsonResponseSizeBytes(historyListBody) <=
      RESPONSE_BUDGET_BYTES["/api/history/get-shop-edithistory"],
    "History list payload exceeded configured budget",
  );
  assert.ok(
    computeJsonResponseSizeBytes(historySummaryBody) <=
      RESPONSE_BUDGET_BYTES["/api/history/get-edit-history-summary/:id"],
    "History summary payload exceeded configured budget",
  );
  assert.ok(
    computeJsonResponseSizeBytes(historyDetailBody) <=
      RESPONSE_BUDGET_BYTES["/api/history/get-edit-history-details/:id"],
    "History detail payload exceeded configured budget",
  );
  assert.ok(
    computeJsonResponseSizeBytes(historyChangesBody) <=
      RESPONSE_BUDGET_BYTES["/api/history/get-edit-history/changes/:id"],
    "History changes payload exceeded configured budget",
  );
  assert.ok(
    computeJsonResponseSizeBytes(importListBody) <=
      RESPONSE_BUDGET_BYTES["/api/history/get-shop-importhistory"],
    "Import history list payload exceeded configured budget",
  );
  assert.ok(
    computeJsonResponseSizeBytes(exportListBody) <=
      RESPONSE_BUDGET_BYTES["/api/history/export/list-summary"],
    "Export list-summary payload exceeded configured budget",
  );
  assert.ok(
    computeJsonResponseSizeBytes(recurringListBody) <=
      RESPONSE_BUDGET_BYTES["/api/products/recurring/list-summary"],
    "Recurring list-summary payload exceeded configured budget",
  );
  assert.ok(
    computeJsonResponseSizeBytes(syncSummaryBody) <=
      RESPONSE_BUDGET_BYTES["/api/sync/sync-status/summary"],
    "Sync summary payload exceeded configured budget",
  );
  assert.ok(
    computeJsonResponseSizeBytes(syncDetailBody) <=
      RESPONSE_BUDGET_BYTES["/api/sync/sync-status/detail"],
    "Sync detail payload exceeded configured budget",
  );
  assert.ok(
    computeJsonResponseSizeBytes(syncDetailBody) <=
      RESPONSE_BUDGET_BYTES["/api/sync/sync-status"],
    "Sync legacy status payload exceeded configured budget",
  );
  assert.ok(
    computeJsonResponseSizeBytes(syncTrackBody) <=
      RESPONSE_BUDGET_BYTES["/api/sync/product-track"],
    "Sync track payload exceeded configured budget",
  );
  assert.ok(
    computeJsonResponseSizeBytes(storeDetailsBody) <=
      RESPONSE_BUDGET_BYTES["/api/store/details"],
    "Store details payload exceeded configured budget",
  );
});
