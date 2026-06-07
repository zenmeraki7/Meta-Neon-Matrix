import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relPath) {
  return fs.readFileSync(path.resolve(relPath), "utf8");
}

test("admin routes are mounted under authenticated /api namespace only", () => {
  const appSource = read("web/app.js");
  const indexSource = read("web/index.js");

  const authIndex = appSource.indexOf('app.use("/api/*", shopify.validateAuthenticatedSession());');
  const adminIndex = appSource.indexOf('app.use("/api/admin", AdminRoutes);');
  assert.ok(authIndex >= 0);
  assert.ok(adminIndex > authIndex);
  assert.ok(indexSource.includes('import "./server.js";'));
  assert.equal(appSource.includes('app.use("/admin", AdminRoutes);'), false);
  assert.equal(indexSource.includes('app.use("/admin", AdminRoutes);'), false);
});

test("admin routes enforce explicit admin-shop authorization middleware", () => {
  const routeSource = read("web/routes/adminRoutes.js");
  const middlewareSource = read("web/middleware/requireAdminShop.js");

  assert.ok(routeSource.includes("router.use(requireAdminShop);"));
  assert.ok(middlewareSource.includes("ADMIN_SHOP_ALLOWLIST"));
  assert.ok(middlewareSource.includes("FORBIDDEN"));
});

test("merchant-owned repositories perform tenant-scoped updates", () => {
  const scheduledExportRepo = read("web/repositories/scheduledExportRepository.js");
  const recurringEditRepo = read("web/repositories/recurringEditRepository.js");
  const snippetRepo = read("web/repositories/productCodeSnippetRepository.js");
  const filterComboRepo = read("web/repositories/filterCombinationRepository.js");

  assert.ok(scheduledExportRepo.includes("updateByIdForShop"));
  assert.ok(scheduledExportRepo.includes("where: { id, shop }"));

  assert.ok(recurringEditRepo.includes("updateByIdForShop"));
  assert.ok(recurringEditRepo.includes("where: { id, shop }"));

  assert.ok(snippetRepo.includes("updateByIdForShop"));
  assert.ok(snippetRepo.includes("where: { id, shop, isDeleted: false }"));

  assert.ok(filterComboRepo.includes("deleteMany"));
  assert.ok(filterComboRepo.includes("id: existing.id"));
  assert.ok(filterComboRepo.includes("shop"));
});

test("targeting metadata persistence enforces owner shop fence", () => {
  const source = read("web/services/targeting/TargetingEngineService.js");
  assert.ok(source.includes("TARGETING_OWNER_SHOP_SCOPE_MISMATCH"));
  assert.ok(source.includes("updateMany"));
  assert.ok(source.includes("where: { id: ownerId, shop: payload.shop }"));
  assert.ok(source.includes("where: { id: ownerId, shop }"));
});

test("scheduled/recurring finalizers include shop mismatch guard", () => {
  const scheduled = read("web/services/scheduledExportExecutionService.js");
  const recurring = read("web/services/recurringEditExecutionService.js");
  const exportWorker = read("web/Jobs/Workers/bulkExportWorker.js");

  assert.ok(scheduled.includes("CROSS_SHOP_SCHEDULED_EXPORT_FINALIZE_BLOCKED"));
  assert.ok(recurring.includes("CROSS_SHOP_RECURRING_FINALIZE_BLOCKED"));
  assert.ok(exportWorker.includes("shop,"));
});

test("export service completion fetch is tenant-scoped", () => {
  const source = read("web/services/productService/productExportService.js");
  assert.ok(source.includes("findFirst"));
  assert.ok(source.includes("id: jobId"));
  assert.ok(source.includes("shop: this.session.shop"));
  assert.equal(source.includes("findUnique({ where: { id: jobId } })"), false);
});
