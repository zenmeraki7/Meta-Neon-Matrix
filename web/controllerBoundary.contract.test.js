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
    "web/controllers/sessionController.js",
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
    source.includes("const session = res.locals.shopify.session;"),
    "syncController.getSyncStatus must source shop from verified session only",
  );
  assert.ok(
    source.includes("const shop = session.shop;"),
    "syncController must trust middleware with assertive session reads",
  );
  assert.equal(
    source.includes("req.query.shop"),
    false,
    "syncController must not trust req.query.shop for tenant selection",
  );
});

test("history controller maps import responses through DTO mappers and avoids legacy recurring path", () => {
  const source = read("web/controllers/historyController.js");

  assert.ok(source.includes("function toImportHistoryListDto("));
  assert.ok(source.includes("function toImportHistoryDetailDto("));
  assert.ok(source.includes("histories.map(toImportHistoryListDto)"));
  assert.ok(source.includes("toImportHistoryDetailDto(history)"));
  assert.equal(source.includes("export const getRecurringEdits"), false);
  assert.equal(source.includes("export const getRecurringEditById"), false);
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

test("cursor-only list endpoints explicitly reject page > 1", () => {
  const historyController = read("web/controllers/historyController.js");
  const recurringController = read("web/controllers/recurringEditController.js");
  const productQueryController = read("web/controllers/productQueryController.js");

  assert.ok(
    historyController.includes("Offset pagination is disabled. Use cursor pagination."),
    "historyController export/import list endpoints must reject offset pagination",
  );
  assert.ok(
    recurringController.includes("Offset pagination is disabled. Use cursor pagination."),
    "recurringEditController list endpoint must reject offset pagination",
  );
  assert.ok(
    productQueryController.includes("Use cursor pagination."),
    "productQueryController must reject offset pagination",
  );
});

test("product query controller delegates query/status persistence concerns to services", () => {
  const controller = read("web/controllers/productQueryController.js");
  const commandService = read("web/services/productService/productQueryCommandService.js");

  assert.ok(
    controller.includes("executeProductQuery("),
    "productQueryController must delegate /get-all execution to productQueryCommandService",
  );
  assert.ok(
    controller.includes("getBulkEditStatus("),
    "productQueryController must delegate /bulk-edit-status to bulkEditStatusService",
  );
  assert.ok(
    controller.includes("const result = await getBulkEditStatus(command);"),
    "productQueryController.checkEditStatus must pass the normalized command directly",
  );
  assert.ok(
    controller.includes("handleLoggedControllerError("),
    "productQueryController must log controller errors with request/session context",
  );
  assert.equal(
    controller.includes("handleControllerError("),
    false,
    "productQueryController must not use unlogged controller errors",
  );
  assert.equal(
    controller.includes("id: command.historyId"),
    false,
    "productQueryController.checkEditStatus must not rebuild the service command shape",
  );
  assert.equal(
    controller.includes("prisma.filterTrack.create"),
    false,
    "productQueryController must not persist filter tracking directly",
  );
  assert.equal(
    controller.includes("prisma.editHistory.findFirst"),
    false,
    "productQueryController must not query edit history directly for status",
  );
  assert.ok(
    commandService.includes("Best-effort telemetry write"),
    "productQueryCommandService must treat telemetry writes as non-fatal",
  );
});

test("product import preview handlers delegate heavy preview pipeline to service", () => {
  const controller = read("web/controllers/productImportController.js");
  const routes = read("web/routes/productRoutes.js");

  assert.ok(
    controller.includes("createImportCsvController"),
    "productImportController must expose an injectable import controller factory",
  );
  assert.ok(
    controller.includes("createCsvPreview("),
    "productImportController must delegate POST /csv/preview to preview service",
  );
  assert.ok(
    controller.includes("previewCsvPage("),
    "productImportController must delegate GET /csv/preview to preview service",
  );
  assert.ok(
    controller.includes("const result = await createCsvPreview(command);"),
    "productImportController.createCsvPreview must pass normalized command directly",
  );
  assert.ok(
    controller.includes("const result = await previewCsvPage(command);"),
    "productImportController.previewCsv must pass normalized command directly",
  );
  assert.ok(
    controller.includes("toProductImportAcceptedDto(result)") &&
      controller.includes("toCsvPreviewResponseDto(result)") &&
      controller.includes("toCsvPreviewPageDto(result)"),
    "productImportController must map service results through response DTOs",
  );
  assert.ok(
    controller.includes("handleLoggedControllerError("),
    "productImportController must log controller errors with request/session context",
  );
  assert.equal(
    controller.includes("new ProductImportCommandService"),
    false,
    "productImportController must not instantiate ProductImportCommandService",
  );
  assert.equal(
    controller.includes("function buildContext("),
    false,
    "productImportController must not pre-shape normalizer context",
  );
  assert.equal(
    controller.includes("handleControllerError("),
    false,
    "productImportController must not use unlogged controller errors",
  );
  assert.equal(
    controller.includes("prisma.spreadsheetFile"),
    false,
    "productImportController must not access spreadsheetFile model directly for preview endpoints",
  );
  assert.equal(
    controller.includes("Papa.parse"),
    false,
    "productImportController must not parse CSV directly for preview endpoints",
  );
  assert.equal(
    controller.includes("fs.promises.readFile"),
    false,
    "productImportController must not read preview CSV files directly",
  );
  assert.ok(
    routes.includes("new ProductImportCommandService()") &&
      routes.includes("createImportCsvController(productImportCommandService)"),
    "productRoutes must compose importCsvController with ProductImportCommandService",
  );
});

test("product sync controller receives command service and logs errors", () => {
  const controller = read("web/controllers/productSyncController.js");
  const routes = read("web/routes/productRoutes.js");

  assert.ok(
    controller.includes("createClearProductTypesController"),
    "productSyncController must expose an injectable controller factory",
  );
  assert.ok(
    controller.includes("handleLoggedControllerError("),
    "productSyncController must log controller errors",
  );
  assert.equal(
    controller.includes("new ProductSyncCommandService"),
    false,
    "productSyncController must not instantiate ProductSyncCommandService",
  );
  assert.equal(
    controller.includes("handleControllerError("),
    false,
    "productSyncController must not use unlogged controller errors",
  );
  assert.ok(
    routes.includes("new ProductSyncCommandService()") &&
      routes.includes("createClearProductTypesController(productSyncCommandService)"),
    "productRoutes must compose clearProductTypes with ProductSyncCommandService",
  );
});

test("sync status handlers delegate read-model logic and enforce locals session source", () => {
  const controller = read("web/controllers/syncController.js");

  assert.ok(
    controller.includes("getSyncStatusDetailForShop("),
    "syncController.getSyncStatus must delegate to syncStatusQueryService",
  );
  assert.ok(
    controller.includes("getSyncStatusSummaryForShop("),
    "syncController.getSyncStatusSummary must delegate to syncStatusQueryService",
  );
  assert.ok(
    controller.includes("getTrackedProductSyncStatus("),
    "syncController.trackProductSync must delegate to syncStatusQueryService",
  );
  assert.ok(
    controller.includes("toSyncStatusDetailDto("),
    "syncController.getSyncStatus must map service result through response DTO",
  );
  assert.ok(
    controller.includes("toSyncStatusSummaryDto("),
    "syncController.getSyncStatusSummary must map service result through response DTO",
  );
  assert.ok(
    controller.includes("toTrackedSyncStatusDto("),
    "syncController.trackProductSync must map service result through response DTO",
  );
  assert.equal(
    controller.includes("req.shopify?.session"),
    false,
    "syncController.trackProductSync must not fallback to req.shopify?.session",
  );
  assert.equal(
    controller.includes("getTrackedProductSyncStatus({ session, shop })"),
    false,
    "syncController.trackProductSync must not pass raw session to service",
  );
  assert.equal(
    controller.includes("createShopifyBulkOperationStatusReader("),
    false,
    "syncController.trackProductSync must not construct Shopify adapters",
  );
});

test("store access controller enforces middleware boundary and response DTO mapping", () => {
  const controller = read("web/controllers/storeController.js");
  const route = read("web/routes/storeRoutes.js");
  const service = read("web/services/storeAccessService.js");

  assert.ok(
    controller.includes("const session = res.locals.shopify.session;"),
    "storeController.getStoreAccess must trust middleware with assertive session reads",
  );
  assert.ok(
    controller.includes("const shop = session.shop;"),
    "storeController.getStoreAccess must source shop from verified session",
  );
  assert.ok(
    controller.includes("getStoreAccessForShop("),
    "storeController.getStoreAccess must delegate to storeAccessService",
  );
  assert.ok(
    controller.includes("toStoreAccessDto("),
    "storeController.getStoreAccess must map service result through response DTO",
  );
  assert.equal(
    controller.includes("getStoreAccessDto("),
    false,
    "storeController.getStoreAccess must not call service DTO wrappers",
  );
  assert.equal(
    controller.includes("{ session }"),
    false,
    "storeController.getStoreAccess must not pass raw session to service",
  );
  assert.equal(
    controller.includes("if (!session?.shop)"),
    false,
    "storeController.getStoreAccess must not keep an inline auth guard",
  );
  assert.ok(
    route.includes("requireShopifySession") &&
      route.includes("attachStoreAccessDependencies"),
    "storeRoutes /details must enforce auth and attach store access dependencies",
  );
  assert.equal(
    service.includes("getStoreAccessDto"),
    false,
    "storeAccessService must not expose service-level DTO wrappers",
  );
});

test("session status stream controller keeps domain and DTO mapping out of SSE lifecycle", () => {
  const controller = read("web/controllers/sessionStatusController.js");

  assert.ok(
    controller.includes("normalizeSessionStatusStreamCommand("),
    "sessionStatusController must delegate stream input normalization",
  );
  assert.ok(
    controller.includes("toSessionProgressEventDto("),
    "sessionStatusController must map progress events through a DTO",
  );
  assert.ok(
    controller.includes("isTerminalSessionStatus("),
    "sessionStatusController must use domain terminal-status helper",
  );
  assert.ok(
    controller.includes("logApiError("),
    "sessionStatusController must log stream errors",
  );
  assert.equal(
    controller.includes("change_count"),
    false,
    "sessionStatusController must not map raw snake_case progress fields inline",
  );
  assert.equal(
    controller.includes("TERMINAL_STATUSES"),
    false,
    "sessionStatusController must not define terminal statuses inline",
  );
  assert.equal(
    controller.includes('String(res.locals.shop || "").trim()'),
    false,
    "sessionStatusController must not normalize shop inline",
  );
  assert.equal(
    controller.includes('String(req.params.id || "").trim()'),
    false,
    "sessionStatusController must not normalize session id inline",
  );
});

test("session controller centralizes public error mapping and logging", () => {
  const controller = read("web/controllers/sessionController.js");

  assert.ok(
    controller.includes("buildPublicApiErrorResponse("),
    "sessionController must use shared public error mapping",
  );
  assert.ok(
    controller.includes("logApiError("),
    "sessionController must log controller errors",
  );
  assert.equal(
    controller.includes("function toStatusCode("),
    false,
    "sessionController must not keep local status-code coercion",
  );
  assert.equal(
    controller.includes("error?.message"),
    false,
    "sessionController must not expose raw error messages",
  );
  assert.equal(
    controller.includes("error.fields"),
    false,
    "sessionController must not expose validation fields inline",
  );
  assert.equal(
    controller.includes('{ error: "Session not found" }'),
    false,
    "sessionController must not keep inline not-found response shapes",
  );
});

test("scheduled export controller normalizes commands and maps success responses", () => {
  const controller = read("web/controllers/scheduledExportController.js");
  const routes = read("web/routes/productRoutes.js");

  assert.ok(
    controller.includes("normalizeCreateScheduledExportCommand("),
    "scheduledExportController.create must normalize before service call",
  );
  assert.ok(
    controller.includes("normalizeUpdateScheduledExportCommand("),
    "scheduledExportController.update must normalize before service call",
  );
  assert.ok(
    controller.includes("normalizeToggleScheduledExportStatusCommand("),
    "scheduledExportController.toggle must normalize before service call",
  );
  assert.ok(
    controller.includes("normalizeDeleteScheduledExportCommand("),
    "scheduledExportController.delete must normalize route params",
  );
  assert.ok(
    controller.includes("toSuccessResponse(") &&
      controller.includes("toScheduledExportDto("),
    "scheduledExportController must use response DTOs",
  );
  assert.ok(
    controller.includes("const session = res.locals.shopify.session;"),
    "scheduledExportController must trust middleware with assertive session reads",
  );
  assert.equal(
    controller.includes("getSessionOrThrow"),
    false,
    "scheduledExportController must not reimplement auth guard",
  );
  assert.equal(
    controller.includes("let session"),
    false,
    "scheduledExportController must not use catch-scope session mutation",
  );
  assert.equal(
    controller.includes("req.subscription"),
    false,
    "scheduledExportController must not pass request subscription to services",
  );
  assert.equal(
    controller.includes("scheduledExportId: req.params.id"),
    false,
    "scheduledExportController must not pass raw route ids to services",
  );
  assert.equal(
    controller.includes("message: \"Scheduled export"),
    false,
    "scheduledExportController must not build success envelope messages inline",
  );
  assert.equal(
    controller.includes('"VALIDATION_FAILED"'),
    false,
    "scheduledExportController catch blocks must not default to validation errors",
  );
  assert.equal(
    controller.includes('"NOT_FOUND"'),
    false,
    "scheduledExportController catch blocks must not default to not-found errors",
  );
  assert.ok(
    routes.includes("requireShopifySession") &&
      routes.includes("createScheduledExportController") &&
      routes.includes("listScheduledExportsController"),
    "scheduled export routes must enforce authenticated session",
  );
});

test("recurring edit controller passes normalized commands directly", () => {
  const controller = read("web/controllers/recurringEditController.js");

  assert.ok(
    controller.includes("const result = await createRecurringEdit(command);"),
    "recurringEditController.create must pass normalized command directly",
  );
  assert.ok(
    controller.includes("const result = await updateRecurringEdit(command);"),
    "recurringEditController.update must pass normalized command directly",
  );
  assert.equal(
    controller.includes("resolveRecurringEditFallbackCode"),
    false,
    "recurringEditController must not classify domain errors locally",
  );
  assert.equal(
    controller.includes("body: command.input"),
    false,
    "recurringEditController.create must not translate command.input to service body",
  );
  assert.equal(
    controller.includes("body: command.patch"),
    false,
    "recurringEditController.update must not translate command.patch to service body",
  );
  assert.equal(
    controller.includes("recurringEditId: command.recurringEditId"),
    false,
    "recurringEditController.update must not rebuild service command shape",
  );
});

test("automatic product rule delete policy is enforced in service layer, not controller", () => {
  const controller = read("web/controllers/automaticProductRuleController.js");
  const commandService = read("web/services/automaticProductRuleCommandService.js");
  const mutateCommand = read("web/services/automaticProductRule/commands/mutateAutomaticProductRuleCommand.js");

  assert.equal(
    controller.includes("assertDeleteConfirmationIfActive("),
    false,
    "automaticProductRuleController must not enforce active-rule delete confirmation policy",
  );
  assert.ok(
    controller.includes("deleteCommand"),
    "automaticProductRuleController must forward delete command payload to service",
  );
  assert.ok(
    commandService.includes("deleteCommand"),
    "automaticProductRuleCommandService must pass delete command to mutation command",
  );
  assert.ok(
    mutateCommand.includes("CONFIRMATION_REQUIRED"),
    "automatic rule delete confirmation policy must be enforced in mutate command service",
  );
});

test("product export uses a single canonical export mutation handler", () => {
  const exportController = read("web/controllers/productExportController.js");
  const productRoutes = read("web/routes/productRoutes.js");
  const productController = read("web/controllers/productController.js");

  assert.equal(
    exportController.includes("handleExportProductsData"),
    false,
    "productExportController must not keep duplicate handleExportProductsData path",
  );
  assert.equal(
    productRoutes.includes("handleExportProductsData"),
    false,
    "productRoutes must not import duplicate export handler",
  );
  assert.equal(
    productController.includes("handleExportProductsData"),
    false,
    "productController must not re-export duplicate export handler",
  );
  assert.ok(
    productRoutes.includes('"/export"') && productRoutes.includes("createProductExport"),
    "POST /export must map to createProductExport",
  );
});

test("product export controller leaves URL safety and command shaping to lower layers", () => {
  const controller = read("web/controllers/productExportController.js");
  const normalizer = read("web/normalizers/productExportCommandNormalizer.js");
  const useCases = read("web/useCases/productExportUseCases.js");

  assert.equal(
    controller.includes("assertSafeDownloadUrl"),
    false,
    "productExportController must not enforce download URL safety",
  );
  assert.equal(
    controller.includes("function buildContext("),
    false,
    "productExportController must not pre-shape command context",
  );
  assert.equal(
    controller.includes("function buildHeaders("),
    false,
    "productExportController must not pre-shape command headers",
  );
  assert.equal(
    controller.includes("context:"),
    false,
    "productExportController must pass raw command parts to normalizers",
  );
  assert.equal(
    controller.includes("headers:"),
    false,
    "productExportController must pass idempotencyKey directly",
  );
  assert.ok(
    controller.includes("const redirect = toExportDownloadRedirectDto(result);") &&
      controller.includes("return res.redirect(redirect.downloadUrl);"),
    "productExportController download must redirect with DTO output",
  );
  assert.ok(
    normalizer.includes("idempotencyKey: normalizeIdempotencyKey(idempotencyKey)"),
    "productExportCommandNormalizer must own idempotency key normalization",
  );
  assert.ok(
    useCases.includes("function assertDownloadUrlSafe(") &&
      useCases.includes("return normalizeDownloadResult(result);"),
    "productExportUseCases.download must own download URL safety",
  );
});

test("product code snippet controller normalizes commands and maps response DTOs", () => {
  const controller = read("web/controllers/productCodeSnippetController.js");
  const normalizer = read("web/normalizers/productCodeSnippetCommandNormalizer.js");
  const dto = read("web/dtos/productCodeSnippetDto.js");

  assert.ok(
    controller.includes("requireShopifySession") &&
      controller.includes("buildAuthenticatedActor"),
    "productCodeSnippetController must use shared auth and actor utilities",
  );
  assert.ok(
    controller.includes("buildCreateProductCodeSnippetCommand(") &&
      controller.includes("buildListProductCodeSnippetsCommand(") &&
      controller.includes("buildPreviewProductCodeSnippetCommand(") &&
      controller.includes("buildSearchSnippetPreviewProductsCommand("),
    "productCodeSnippetController must normalize request input for all operation families",
  );
  assert.ok(
    controller.includes("toSnippetCreatedDto(") &&
      controller.includes("toSnippetListDto(") &&
      controller.includes("toSnippetValidationResponseDto(") &&
      controller.includes("toSnippetPreviewProductsDto("),
    "productCodeSnippetController must map service results through DTOs",
  );
  assert.equal(
    controller.includes("function getSessionOrThrow("),
    false,
    "productCodeSnippetController must not reimplement session auth",
  );
  assert.equal(
    controller.includes("function getUserFromSession("),
    false,
    "productCodeSnippetController must not resolve actor identity locally",
  );
  assert.equal(
    controller.includes("successResponse("),
    false,
    "productCodeSnippetController must not wrap raw service data in generic success envelopes",
  );
  assert.equal(
    controller.includes("errorResponse("),
    false,
    "productCodeSnippetController validation status mapping must live in DTOs",
  );
  assert.equal(
    controller.includes('validationStatus === "VALID"'),
    false,
    "productCodeSnippetController must not branch on validation status",
  );
  assert.equal(
    controller.includes('"VALIDATION_FAILED"'),
    false,
    "productCodeSnippetController catch blocks must default to internal errors",
  );
  assert.equal(
    controller.includes('"NOT_FOUND"'),
    false,
    "productCodeSnippetController catch blocks must not default to not-found",
  );
  assert.ok(
    normalizer.includes("buildCreateProductCodeSnippetCommand") &&
      normalizer.includes("buildValidateProductCodeSnippetCommand"),
    "productCodeSnippetCommandNormalizer must expose per-operation builders",
  );
  assert.ok(
    dto.includes("toSnippetValidationResponseDto") &&
      dto.includes("statusCode: 422"),
    "productCodeSnippetDto must own validation response status mapping",
  );
});

test("product bulk edit controller uses shared utilities and raw normalizer inputs", () => {
  const controller = read("web/controllers/productBulkEditController.js");
  const normalizer = read("web/normalizers/productBulkEditCommandNormalizer.js");
  const dto = read("web/dtos/productBulkEditDto.js");
  const errorLogUtils = read("web/utils/errorLogUtils.js");

  assert.ok(
    controller.includes("requireShopifySession") &&
      controller.includes("buildAuthenticatedActor") &&
      controller.includes("getIdempotencyKey") &&
      controller.includes("handleLoggedControllerError") &&
      controller.includes("setPrivateNoStore"),
    "productBulkEditController must use shared controller/cache utilities",
  );
  assert.equal(
    controller.includes("function requireShopifySession("),
    false,
    "productBulkEditController must not reimplement session auth",
  );
  assert.equal(
    controller.includes("buildActorFromSession"),
    false,
    "productBulkEditController must not parse Shopify user identity locally",
  );
  assert.equal(
    controller.includes("buildBaseCommandContext"),
    false,
    "productBulkEditController must not pre-shape command context",
  );
  assert.equal(
    controller.includes("buildHeaderSnapshot"),
    false,
    "productBulkEditController must not pre-shape command headers",
  );
  assert.equal(
    controller.includes("buildCommand("),
    false,
    "productBulkEditController must not hide session and command creation in a controller factory",
  );
  assert.equal(
    controller.includes("logAndSendError"),
    false,
    "productBulkEditController must not classify errors locally",
  );
  assert.equal(
    controller.includes("buildSafeRequestLogContext"),
    false,
    "productBulkEditController must pass raw req to shared logging",
  );
  assert.equal(
    controller.includes("toUndoEditResponseDto(result,"),
    false,
    "productBulkEditController undo DTO must receive result only",
  );
  assert.ok(
    normalizer.includes("idempotencyKey: normalizeIdempotencyKey(idempotencyKey)") &&
      normalizer.includes("function assertCommandContext({"),
    "productBulkEditCommandNormalizer must own direct command context/idempotency normalization",
  );
  assert.equal(
    normalizer.includes("headers = {}"),
    false,
    "productBulkEditCommandNormalizer must not require pre-shaped header snapshots",
  );
  assert.equal(
    normalizer.includes("context,"),
    false,
    "productBulkEditCommandNormalizer must not require pre-shaped context objects",
  );
  assert.equal(
    dto.includes("toUndoEditResponseDto(result, command)"),
    false,
    "productBulkEditDto undo response must not depend on input command shape",
  );
  assert.ok(
    errorLogUtils.includes("function sanitizeRequestForLogging("),
    "logApiError must own request sanitization",
  );
});

test("metafield definitions controller delegates data access and DTO mapping", () => {
  const controller = read("web/controllers/metafieldDefinitionsController.js");
  const service = read("web/services/metafieldDefinitionService.js");
  const dto = read("web/dtos/metafieldDefinitionDto.js");

  assert.equal(
    controller.includes("../db/"),
    false,
    "metafieldDefinitionsController must not import the db layer directly",
  );
  assert.ok(
    controller.includes("requireShopifySession"),
    "metafieldDefinitionsController must use shared session auth",
  );
  assert.ok(
    controller.includes("getMetafieldDefinitions("),
    "metafieldDefinitionsController must call the service layer",
  );
  assert.ok(
    controller.includes("toMetafieldDefinitionListDto("),
    "metafieldDefinitionsController must map through a DTO",
  );
  assert.ok(
    controller.includes("logApiError(") &&
      controller.includes("buildPublicApiErrorResponse("),
    "metafieldDefinitionsController must log and return sanitized errors",
  );
  assert.equal(
    controller.includes("res.locals?.shop"),
    false,
    "metafieldDefinitionsController must not use ambiguous locals shop fallback",
  );
  assert.equal(
    controller.includes("error?.message"),
    false,
    "metafieldDefinitionsController must not expose raw error messages",
  );
  assert.equal(
    controller.includes("shopify_definition_id"),
    false,
    "metafieldDefinitionsController must not map db columns inline",
  );
  assert.ok(
    service.includes('from "../db/metafieldDefinitions.js"'),
    "metafieldDefinitionService must own db access",
  );
  assert.ok(
    dto.includes("shopify_definition_id") &&
      dto.includes("visible_to_storefront"),
    "metafieldDefinitionDto must own database-to-api field mapping",
  );
});

test("bootstrap controller delegates fan-out and recovery to use cases", () => {
  const controller = read("web/controllers/bootstrapController.js");
  const useCases = read("web/useCases/bootstrapUseCases.js");
  const dto = read("web/dtos/bootstrapDto.js");

  assert.ok(
    controller.includes("getProductsBootstrapData(") &&
      controller.includes("getDashboardBootstrapData("),
    "bootstrapController must call one bootstrap use case per handler",
  );
  assert.equal(
    controller.includes("Promise.all("),
    false,
    "bootstrapController must not orchestrate bootstrap service fan-out",
  );
  assert.equal(
    controller.includes("resolveProductListForBootstrap"),
    false,
    "bootstrapController must not own product-list fallback logic",
  );
  assert.equal(
    controller.includes("isRecoverableProductListBootstrapError"),
    false,
    "bootstrapController must not classify recoverable product-list errors",
  );
  assert.equal(
    controller.includes("storeAccessDependencies"),
    false,
    "bootstrapController must not wire store access infrastructure dependencies",
  );
  assert.equal(
    controller.includes("toStoreAccessDto("),
    false,
    "bootstrapController must not assemble nested DTOs inline",
  );
  assert.equal(
    controller.includes("generatedAt: new Date"),
    false,
    "bootstrapController must not generate response timestamps inline",
  );
  assert.ok(
    useCases.includes("Promise.all(") &&
      useCases.includes("resolveProductListForBootstrap") &&
      useCases.includes("RECOVERABLE_PRODUCT_LIST_BOOTSTRAP_CODES"),
    "bootstrapUseCases must own fan-out and recoverable product-list handling",
  );
  assert.ok(
    dto.includes("toStoreAccessDto(") &&
      dto.includes("generatedAt: asIso(payload.generatedAt) || new Date().toISOString()"),
    "bootstrapDto must own nested DTO assembly and timestamp defaults",
  );
});

test("suggestion submit route enforces authenticated session and body validation", () => {
  const suggestionRoute = read("web/routes/SuggestionRoutes.js");
  const suggestionController = read("web/controllers/suggestionController.js");

  assert.ok(
    suggestionRoute.includes("validateSession"),
    "SuggestionRoutes POST /submit must enforce validateSession",
  );
  assert.ok(
    suggestionRoute.includes("validateBody(suggestionCreateSchema)"),
    "SuggestionRoutes POST /submit must enforce suggestionCreateSchema body validation",
  );
  assert.ok(
    suggestionController.includes("UNAUTHENTICATED"),
    "suggestionController.addSuggestion must reject unauthenticated requests",
  );
});
