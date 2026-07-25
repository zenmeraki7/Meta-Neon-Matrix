import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(".");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("product browsing endpoints log errorId and use session-scoped shop", () => {
  const controller = read("web/controllers/productQueryController.js");
  const bootstrap = read("web/controllers/bootstrapController.js");
  const commandService = read("web/services/productService/productQueryCommandService.js");

  assert.match(controller, /handleLoggedControllerError/);
  assert.match(controller, /shop:\s*session\.shop/);
  assert.doesNotMatch(controller, /req\.(query|body)\.shop/);
  assert.match(bootstrap, /shop:\s*session\.shop/);
  assert.match(commandService, /MIRROR_BATCH_OVERRIDE_FORBIDDEN/);
  assert.match(commandService, /RAW_QUERY_WHERE_FORBIDDEN/);
});

test("product browsing normalizes empty input, limits, and invalid cursors safely", () => {
  const commandService = read("web/services/productService/productQueryCommandService.js");
  const bootstrapNormalizer = read("web/normalizers/bootstrapQueryNormalizer.js");
  const targeting = read("web/services/productService/productTargetingService.js");

  assert.match(commandService, /const DEFAULT_LIMIT = 50/);
  assert.match(commandService, /const MAX_LIMIT = 100/);
  assert.match(commandService, /:\s*\[\];/);
  assert.match(commandService, /body\.filter != null/);
  assert.match(commandService, /direction === "next"/);
  assert.match(bootstrapNormalizer, /fallback:\s*50/);
  assert.match(bootstrapNormalizer, /max:\s*100/);
  assert.match(targeting, /INVALID_CURSOR/);
  assert.match(targeting, /statusCode = 400/);
  assert.match(targeting, /rawFilterInput\.length === 0/);
  assert.match(targeting, /return \{\};/);
});

test("sync summary exposes one backend source of truth for product mirror status", () => {
  const syncStatus = read("web/services/syncStatusQueryService.js");
  const syncRepository = read("web/repositories/syncRepository.js");

  assert.match(syncRepository, /getActiveProductCountByShop/);
  assert.match(syncStatus, /DEFAULT_STORE_SYNC_STATE/);
  assert.match(syncStatus, /mirrorReady:\s*Boolean\(mirrorReady\)/);
  assert.match(syncStatus, /productsSynced/);
  assert.match(syncStatus, /syncNeeded/);
  assert.match(syncStatus, /emptyMirror/);
  assert.match(syncStatus, /latestCompletedSync/);
  assert.match(syncStatus, /getLatestCompletedProductSyncByShop/);

  const summaryStart = syncStatus.indexOf("export async function getSyncStatusSummaryForShop");
  const trackedStart = syncStatus.indexOf("export async function getTrackedProductSyncStatus");
  assert.ok(summaryStart >= 0 && trackedStart > summaryStart);
  const summarySource = syncStatus.slice(summaryStart, trackedStart);
  assert.doesNotMatch(summarySource, /throw error;/);
});

test("product sync lifecycle bootstraps Store rows instead of raw store.update calls", () => {
  const storeRepository = read("web/repositories/storeRepository.js");
  const productSyncRepository = read("web/repositories/productSyncRepository.js");
  const mirrorHealth = read("web/services/mirrorHealthService.js");
  const syncCommand = read("web/services/sync/SyncCommandService.js");
  const productSyncService = read("web/services/productService/productSyncService.js");

  assert.match(storeRepository, /export async function ensureStoreForShop/);
  assert.match(storeRepository, /tx\.store\.upsert/);
  assert.match(syncCommand, /ensureStoreForShop/);
  assert.match(productSyncService, /ensureStoreForShop/);
  assert.match(productSyncRepository, /ensureStoreForShop/);
  assert.match(mirrorHealth, /ensureStoreForShop/);

  for (const source of [productSyncRepository, mirrorHealth]) {
    assert.doesNotMatch(source, /\.store\.update\(/);
    assert.doesNotMatch(source, /prisma\.store\.update\(/);
    assert.doesNotMatch(source, /db\.store\.update\(/);
  }
});

test("products page prioritizes errors before sync-needed and filtered-empty states", () => {
  const page = read("web/frontend/Domain/products/list/pages/Products.jsx");
  const hook = read("web/frontend/Domain/products/list/hooks/useProducts.js");
  const syncPage = read("web/frontend/Domain/settings/sync/pages/SyncPage.jsx");

  assert.match(page, /pageError/);
  assert.match(page, /Products could not be loaded/);
  assert.match(page, /shouldShowSyncNeededState/);
  assert.match(page, /shouldShowFilteredEmptyState/);
  assert.match(page, /syncStatus\?\.syncNeeded/);
  assert.match(hook, /initialDataUpdatedAt/);
  assert.match(hook, /data\?\.data/);
  assert.match(syncPage, /useQueryClient/);
  assert.match(syncPage, /productsSynced/);
});

test("products filter builder supports searchable fields, enum status, and scoped value suggestions", () => {
  const productsFilters = read("web/frontend/Domain/products/list/components/ProductsFilters.jsx");
  const valueInput = read("web/frontend/Domain/products/list/components/FilterValueInput.jsx");
  const commandService = read("web/services/productService/productQueryCommandService.js");
  const productQueryService = read("web/services/productService/productQueryService.js");
  const legacyAdapter = read("web/services/targeting/adapters/legacyFilterParamsAdapter.js");

  assert.match(productsFilters, /fieldSearchDraft/);
  assert.match(productsFilters, /filteredFieldOptions/);
  assert.match(productsFilters, /filter\.searchAliases/);
  assert.match(productsFilters, /Search filter fields/);

  assert.ok(
    valueInput.indexOf('filter.type === "enum"') < valueInput.indexOf("filter.isSearchable"),
    "enum filters must render fixed choices before searchable autocomplete"
  );
  assert.match(valueInput, /ChoiceList/);

  assert.match(commandService, /FILTER_UI_OVERRIDES/);
  assert.match(
    commandService,
    /title:\s*\{[^}]*isSearchable:\s*false[^}]*\}/,
    "title must remain a free-text filter unless a title suggestions API is configured",
  );
  assert.match(commandService, /status:\s*\{/);
  assert.match(commandService, /values:\s*\["ACTIVE",\s*"DRAFT",\s*"ARCHIVED"\]/);
  assert.match(commandService, /api:\s*"\/api\/products\/filter-values\/vendor"/);
  assert.match(commandService, /api:\s*"\/api\/products\/filter-values\/product_type"/);
  assert.match(commandService, /api:\s*"\/api\/products\/filter-values\/collection"/);
  assert.match(commandService, /buildFilterFieldDto/);

  const dto = read("web/dtos/productQueryDto.js");
  assert.match(dto, /item\.value \?\? item\.title \?\? item\.name \?\? item\.label \?\? item\.id/);
  assert.match(dto, /data,\s*\n\s*meta:\s*\{\s*count:\s*data\.length\s*\}/);

  assert.match(productQueryService, /productType:\s*\{\s*source:\s*"product",\s*field:\s*"productType"\s*\}/);
  assert.match(productQueryService, /tags:\s*\{\s*source:\s*"product_tags",\s*field:\s*"value"\s*\}/);
  assert.match(productQueryService, /collections:\s*\{\s*source:\s*"collection",\s*field:\s*"title"\s*\}/);

  assert.match(legacyAdapter, /IS:\s*"EQ"/);
  assert.match(legacyAdapter, /"IS NOT":\s*"NEQ"/);
  assert.match(legacyAdapter, /"DOES NOT CONTAIN":\s*"NOT_CONTAINS"/);
});
