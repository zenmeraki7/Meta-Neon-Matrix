import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(file) {
  return fs.readFileSync(path.resolve(file), "utf8");
}

test("high-traffic endpoints are covered by response budgets", () => {
  const source = read("web/middleware/responseBudgetMiddleware.js");
  const requiredRoutes = [
    "/api/products/get-all",
    "/api/products/edit-preview",
    "/api/history/get-shop-edithistory",
    "/api/history/get-edit-history-summary/:id",
    "/api/history/get-edit-history-details/:id",
    "/api/history/get-edit-history/changes/:id",
    "/api/history/get-shop-importhistory",
    "/api/history/export/list-summary",
    "/api/history/export/detail/:id",
    "/api/products/recurring/list-summary",
    "/api/products/recurring/detail/:id",
    "/api/sync/sync-status",
    "/api/sync/sync-status/summary",
    "/api/sync/sync-status/detail",
    "/api/sync/product-track",
    "/api/store/details",
  ];

  for (const route of requiredRoutes) {
    assert.ok(
      source.includes(`"${route}"`),
      `Missing response budget route coverage: ${route}`,
    );
  }
});

test("cursor-only contracts are enforced on list controllers and frontend list clients avoid page-style queries", () => {
  const historyController = read("web/controllers/historyController.js");
  const recurringController = read("web/controllers/recurringEditController.js");
  const productQueryController = read("web/controllers/productQueryController.js");
  const historyService = read("web/frontend/Domain/History/services/historyService.js");
  const exportTable = read("web/frontend/Domain/History/components/ExportTable.tsx");
  const recurringTable = read("web/frontend/Domain/History/components/RecurringHistoryTable.jsx");
  const historyComponent = read("web/frontend/Domain/History/components/HistoryComponent.jsx");

  const rejectionMsg = "Use cursor pagination.";
  assert.ok(historyController.includes(rejectionMsg));
  assert.ok(recurringController.includes(rejectionMsg));
  assert.ok(productQueryController.includes("Use cursor pagination."));

  assert.ok(historyService.includes('"cursor"'));
  assert.equal(
    historyService.includes('"page"'),
    false,
    "History service should not include page-style query contract",
  );

  assert.equal(
    exportTable.includes("?page="),
    false,
    "Export table should not request page-style pagination",
  );
  assert.equal(
    recurringTable.includes("?page="),
    false,
    "Recurring table should not request page-style pagination",
  );
  assert.equal(
    historyComponent.includes("?page="),
    false,
    "History component should not request page-style pagination",
  );
});

test("hidden-tab polling guards exist for sync and polling history surfaces", () => {
  const syncQueryHook = read("web/frontend/hooks/useSyncStatusQuery.js");
  const exportTable = read("web/frontend/Domain/History/components/ExportTable.tsx");
  const editDetails = read("web/frontend/Domain/products/edit/pages/EditDetails.jsx");

  assert.ok(syncQueryHook.includes("enabled: isVisible"));
  assert.ok(syncQueryHook.includes("refetchIntervalInBackground: false"));
  assert.ok(syncQueryHook.includes("isVisible && isActiveSyncStatus"));

  assert.ok(exportTable.includes("document.visibilityState !== \"visible\""));
  assert.ok(editDetails.includes("document.visibilityState !== \"visible\""));
});

test("duplicate-call guards exist for preview and history list/detail fetch paths", () => {
  const editPreview = read("web/frontend/Domain/products/edit/pages/EditPreviewPage.jsx");
  const recurringTable = read("web/frontend/Domain/History/components/RecurringHistoryTable.jsx");

  assert.ok(editPreview.includes("previewAbortRef"));
  assert.ok(editPreview.includes("latestPreviewSignatureRef"));
  assert.ok(editPreview.includes("previewAbortRef.current?.abort()"));

  assert.ok(recurringTable.includes("listRequestIdRef"));
  assert.ok(recurringTable.includes("detailsRequestIdRef"));
  assert.ok(recurringTable.includes("requestId !== listRequestIdRef.current"));
  assert.ok(recurringTable.includes("requestId !== detailsRequestIdRef.current"));
});

