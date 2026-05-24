import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(file) {
  return fs.readFileSync(path.resolve(file), "utf8");
}

test("controllers do not instantiate Shopify Graphql clients directly in migrated endpoints", () => {
  const productSync = read("web/controllers/productSyncController.js");
  const category = read("web/controllers/categoryController.js");
  const collection = read("web/controllers/collectionController.js");
  const subscription = read("web/controllers/subscriptionController.js");

  const sources = [
    ["productSyncController", productSync],
    ["categoryController", category],
    ["collectionController", collection],
    ["subscriptionController", subscription],
  ];

  for (const [name, source] of sources) {
    assert.equal(
      source.includes("new shopify.api.clients.Graphql"),
      false,
      `${name} still constructs Shopify Graphql client`,
    );
  }
});

test("controllers delegate to command/service boundaries for migrated operations", () => {
  const productSync = read("web/controllers/productSyncController.js");
  const category = read("web/controllers/categoryController.js");
  const collection = read("web/controllers/collectionController.js");
  const subscription = read("web/controllers/subscriptionController.js");
  const productExport = read("web/controllers/productExportController.js");
  const productImport = read("web/controllers/productImportController.js");

  assert.ok(
    productSync.includes("createClearProductTypesCommand"),
    "productSyncController must delegate clearProductTypes to command service",
  );
  assert.ok(
    category.includes("categoryService.getAllCategories"),
    "categoryController must delegate to categoryService.getAllCategories",
  );
  assert.ok(
    collection.includes("collectionControllerService.fetchFromShopify"),
    "collectionController must delegate Shopify collection fetch to service",
  );
  assert.ok(
    subscription.includes("createSubscriptionCommand"),
    "subscriptionController must delegate billing orchestration to command service",
  );
  assert.ok(
    productExport.includes("ProductExportCommandService"),
    "productExportController must use ProductExportCommandService naming/ownership",
  );
  assert.equal(
    productExport.includes("new ProductExportService("),
    false,
    "productExportController must not instantiate ProductExportService directly",
  );
  assert.ok(
    productImport.includes('idempotencyKey: req.headers["idempotency-key"]'),
    "productImportController must forward idempotency key to command service",
  );
});

test("controllers use sanitized public error responses", () => {
  const files = [
    "web/controllers/productSyncController.js",
    "web/controllers/categoryController.js",
    "web/controllers/collectionController.js",
    "web/controllers/subscriptionController.js",
    "web/controllers/historyController.js",
    "web/controllers/syncController.js",
    "web/controllers/storeController.js",
    "web/controllers/adminController.js",
    "web/controllers/automaticProductRuleController.js",
    "web/controllers/scheduledExportController.js",
    "web/controllers/productCodeSnippetController.js",
    "web/controllers/productExportController.js",
  ];

  for (const file of files) {
    const source = read(file);
    assert.ok(
      source.includes("buildPublicApiErrorResponse"),
      `${file} is missing buildPublicApiErrorResponse usage`,
    );
    assert.equal(
      source.includes("message: error.message"),
      false,
      `${file} still exposes raw error.message`,
    );
  }
});

test("sync status requires verified session shop and does not fallback to query shop", () => {
  const source = read("web/controllers/syncController.js");
  assert.ok(
    source.includes("const shop = session?.shop;"),
    "syncController.getSyncStatus must source shop from verified session only",
  );
  assert.equal(
    source.includes("req.query.shop"),
    false,
    "syncController must not trust req.query.shop for tenant selection",
  );
});

test("history controller maps import and recurring responses through DTO mappers", () => {
  const source = read("web/controllers/historyController.js");

  assert.ok(source.includes("function toImportHistoryListDto("));
  assert.ok(source.includes("function toImportHistoryDetailDto("));
  assert.ok(source.includes("function toRecurringJobDto("));
  assert.ok(source.includes("histories.map(toImportHistoryListDto)"));
  assert.ok(source.includes("toImportHistoryDetailDto(history)"));
  assert.ok(source.includes("datas.map(toRecurringJobDto)"));
  assert.ok(source.includes("toRecurringJobDto(job)"));
});

test("history DTO contract blocks internal/private fields", () => {
  const source = read("web/controllers/historyController.js");
  const forbidden = [
    "executionIdentity",
    "batch",
    "undo",
    "workerPayload",
    "retryCounter",
    "errorStack",
  ];

  for (const key of forbidden) {
    assert.equal(
      source.includes(key),
      false,
      `history controller still references internal field ${key}`,
    );
  }
});
