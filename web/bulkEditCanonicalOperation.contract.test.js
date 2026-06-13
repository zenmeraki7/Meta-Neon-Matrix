import test from "node:test";
import assert from "node:assert/strict";
import { buildBulkEditPreviewCommand } from "./normalizers/productBulkEditCommandNormalizer.js";
import { toBulkEditPreviewResponseDto } from "./dtos/productBulkEditDto.js";
import { getUpdatedProducts } from "./helpers/productBulkOperationHelpers/productUpdateHandler.js";
import {
  bulkEditExecuteSchema,
  bulkEditPreviewSchema,
} from "./validations/controllerRequestSchemas.js";
import { compileFilterAst } from "./services/targeting/compile/compileFilterAst.js";
import { validateFilterAstOrThrow } from "./services/targeting/validate/filterAstValidator.js";
import { buildPublicApiErrorResponse } from "./utils/publicApiError.js";
import fs from "node:fs";
import path from "node:path";

const exactCanonicalPricePayload = Object.freeze({
  field: "price",
  operation: "SET_FIXED",
  value: "600",
  locationId: "",
  rounding: "NONE",
  filterAst: {
    version: "2.0.0",
    root: {
      nodeType: "group",
      logic: "AND",
      children: [],
    },
  },
  filterFingerprint: "filter_yb6iq0",
  filterVersion: "2.0.0",
  limit: 10,
  page: 1,
});

test("bulk edit preview route schema accepts exact canonical price payload", () => {
  const { error, value } = bulkEditPreviewSchema.validate(exactCanonicalPricePayload, {
    abortEarly: false,
    convert: true,
    allowUnknown: false,
    stripUnknown: true,
  });

  assert.equal(error, undefined);
  assert.equal(value.field, "price");
  assert.equal(value.operation, "SET_FIXED");
  assert.equal(value.value, "600");
  assert.equal(value.locationId, "");
  assert.equal(value.rounding, "NONE");
  assert.equal(value.limit, 10);
  assert.equal(value.page, 1);
});

test("bulk edit execute route schema accepts preview-backed price payload", () => {
  const executePayload = {
    field: "price",
    operation: "INCREASE_PERCENT",
    value: "20",
    location: "",
    rounding: "NONE",
    confirmBroadTarget: false,
    filterParams: [
      {
        field: "vendor",
        operator: "equals",
        value: "ROJAL FASHION NEW",
      },
    ],
    previewId: "40f699c6-7c2f-427c-a331-eb6a3f2b738d",
    previewSignature: "sig_1j0hb5y",
    previewMirrorBatchId:
      "product_sync_1780467785232_3ebebecc-6e4e-4498-88f8-e9b391d2aaa4",
    previewFilterHash:
      "2c1df2236d09d7f48597b4af29731c2d929519d1da36d1aa3706350ec633eae1",
    previewFieldRegistryVersion: "2026-05-Phase2-v1",
    previewOperatorRegistryVersion: "2026-05-Phase2-v1",
  };

  const { error, value } = bulkEditExecuteSchema.validate(executePayload, {
    abortEarly: false,
    convert: true,
    allowUnknown: false,
    stripUnknown: true,
  });

  assert.equal(error, undefined);
  assert.equal(value.rounding, "NONE");
  assert.equal(value.previewSignature, "sig_1j0hb5y");
  assert.equal(value.previewId, executePayload.previewId);
  assert.equal(value.previewFilterHash, executePayload.previewFilterHash);
});

test("bulk edit preview accepts canonical price operation and value", () => {
  const command = buildBulkEditPreviewCommand({
    query: { lang: "en" },
    context: {
      shop: "demo-shop.myshopify.com",
      actor: { type: "SHOPIFY_USER", actorId: "1" },
      activePlan: {},
    },
    body: {
      ...exactCanonicalPricePayload,
      value: "100",
      filterFingerprint: "filter_test",
    },
  });

  assert.equal(command.editedField, "price");
  assert.equal(command.operation, "SET_FIXED");
  assert.equal(command.editType, "Set to fixed value");
  assert.equal(command.editValue, "100");
});

test("bulk edit preview preserves authenticated session token for service clients", () => {
  const command = buildBulkEditPreviewCommand({
    query: { lang: "en" },
    context: {
      shop: "demo-shop.myshopify.com",
      accessToken: "shpat_preview_token",
      scope: "read_products,write_products",
      actor: { type: "SHOPIFY_USER", actorId: "1" },
      activePlan: {},
    },
    body: exactCanonicalPricePayload,
  });

  assert.equal(command.shop, "demo-shop.myshopify.com");
  assert.equal(command.accessToken, "shpat_preview_token");
  assert.equal(command.scope, "read_products,write_products");
});

test("price preview response exposes flat variant rows with two decimal values", () => {
  const product = {
    id: "gid://shopify/Product/10030162182459",
    title: "ITS A TRENDING PRODUCT hey new arrived",
    variants: [
      {
        id: "gid://shopify/ProductVariant/1",
        title: "Default Title",
        price: 553,
        compareAtPrice: 0,
      },
    ],
  };
  const preview = [
    getUpdatedProducts({
      product,
      field: "price",
      editType: "Increase by percent",
      value: "80",
      isTracking: true,
    }),
  ];
  const dto = toBulkEditPreviewResponseDto({
    data: {
      preview,
      canonicalField: "price",
      operation: "INCREASE_PERCENT",
      value: "80",
      isVariant: true,
      matchingProductCount: 1,
      variantCount: 1,
      rounding: "NONE",
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
      previewFingerprint: {
        previewId: "preview-1",
        filterHash: "filter_yb6iq0",
      },
    },
  });

  assert.equal(dto.success, true);
  assert.equal(dto.rows[0].currentValue, "553.00");
  assert.equal(dto.rows[0].newValue, "995.40");
  assert.equal(dto.rows[0].status, "READY");
  assert.equal(dto.data.rows[0].variants[0].oldValue.displayText, "553.00");
  assert.equal(dto.data.rows[0].variants[0].newValue.displayText, "995.40");
});

test("targeting accepts empty root and compiles price filters for matching variants", () => {
  const emptyAst = {
    version: "2.0.0",
    root: { nodeType: "group", logic: "AND", children: [] },
    options: { targetGranularity: "PRODUCT_WITH_MATCHING_VARIANTS" },
    context: { source: "MANUAL_PREVIEW" },
  };

  assert.equal(
    validateFilterAstOrThrow(emptyAst, {
      targetGranularity: "PRODUCT_WITH_MATCHING_VARIANTS",
      source: "MANUAL_PREVIEW",
    }),
    true,
  );

  const priceAst = {
    ...emptyAst,
    root: {
      nodeType: "group",
      logic: "AND",
      children: [
        {
          nodeType: "predicate",
          field: "price",
          operator: "GT",
          value: 100,
        },
      ],
    },
  };
  const compiled = compileFilterAst(priceAst, {
    dialect: "db",
    context: {
      targetGranularity: "PRODUCT_WITH_MATCHING_VARIANTS",
      source: "MANUAL_PREVIEW",
    },
  });

  assert.equal(compiled.targetModel, "Product");
  assert.deepEqual(compiled.where, {
    AND: [{ variants: { some: { price: { gt: 100 } } } }],
  });
});

test("bulk edit preview rejects empty price value", () => {
  assert.throws(
    () =>
      buildBulkEditPreviewCommand({
        query: { lang: "en" },
        context: {
          shop: "demo-shop.myshopify.com",
          actor: { type: "SHOPIFY_USER", actorId: "1" },
          activePlan: {},
        },
        body: {
          field: "price",
          operation: "SET_FIXED",
          value: null,
          filterAst: {
            version: "2.0.0",
            root: {
              nodeType: "group",
              logic: "AND",
              children: [],
            },
          },
          filterFingerprint: "filter_test",
          filterVersion: "2.0.0",
        },
      }),
    /Enter a valid price/,
  );
});

test("preview mirror safety errors use sync-required public contract", () => {
  const { statusCode, body } = buildPublicApiErrorResponse(
    { code: "TARGETING_MIRROR_UNSAFE" },
    "EDIT_PREVIEW_FAILED",
  );

  assert.equal(statusCode, 409);
  assert.equal(body.success, false);
  assert.equal(body.code, "TARGETING_REQUIRES_SYNC");
  assert.equal(
    body.message,
    "Refresh product data before previewing this edit.",
  );
});

test("expired preview errors are not reported as validation failures", () => {
  const { statusCode, body } = buildPublicApiErrorResponse(
    { code: "PREVIEW_EXPIRED" },
    "VALIDATION_FAILED",
  );

  assert.equal(statusCode, 409);
  assert.equal(body.success, false);
  assert.equal(body.code, "PREVIEW_STALE");
  assert.equal(
    body.message,
    "Preview is stale. Run preview again before applying this edit.",
  );
  assert.equal(body.errors, undefined);
});

test("preview ownership internals are not reported as validation failures", () => {
  const { statusCode, body } = buildPublicApiErrorResponse(
    { message: "PREVIEW_OWNERSHIP_UNBOUND" },
    "VALIDATION_FAILED",
  );

  assert.equal(statusCode, 500);
  assert.equal(body.success, false);
  assert.equal(body.code, "EDIT_EXECUTION_FAILED");
  assert.equal(
    body.message,
    "Unable to start this edit. Run preview again and retry.",
  );
  assert.equal(body.errors, undefined);
});

test("incomplete preview snapshots are lifecycle conflicts, not validation errors", () => {
  const { statusCode, body } = buildPublicApiErrorResponse(
    { message: "PREVIEW_SNAPSHOT_INCOMPLETE" },
    "VALIDATION_FAILED",
  );

  assert.equal(statusCode, 409);
  assert.equal(body.success, false);
  assert.equal(body.code, "PREVIEW_SNAPSHOT_INCOMPLETE");
  assert.equal(
    body.message,
    "Preview data is incomplete. Run preview again before applying this edit.",
  );
  assert.equal(body.errors, undefined);
});

test("preview execution persists rows and freezes from persisted preview rows", () => {
  const previewSource = fs.readFileSync(
    path.resolve("web/services/productService/ProductBulkPreviewService.js"),
    "utf8",
  );
  const commandSource = fs.readFileSync(
    path.resolve("web/services/bulkEdit/BulkEditCommandService.js"),
    "utf8",
  );
  const freezeSource = fs.readFileSync(
    path.resolve("web/services/bulkEdit/BulkEditTargetFreezeService.js"),
    "utf8",
  );
  const snapshotSetSource = fs.readFileSync(
    path.resolve("web/repositories/targetSnapshotSetRepository.js"),
    "utf8",
  );

  assert.match(previewSource, /executablePreviewRows/);
  assert.match(previewSource, /plannedMutation/);
  assert.match(previewSource, /jsonlRow: JSON\.stringify\(\{ productSet \}\)/);
  assert.match(commandSource, /getReadyPreviewRows/);
  assert.match(commandSource, /previewRows: readyPreviewRows/);
  assert.match(freezeSource, /history\.batch\?\.previewRows/);
  assert.match(freezeSource, /source: "MANUAL_PREVIEW"/);
  assert.match(snapshotSetSource, /plannedMutation/);
  assert.match(snapshotSetSource, /legacyRow\.beforeValues\.plannedMutation/);
});

test("run edit and history APIs expose scalar history ids", () => {
  const dtoSource = fs.readFileSync(
    path.resolve("web/dtos/productBulkEditDto.js"),
    "utf8",
  );
  const historyUseCaseSource = fs.readFileSync(
    path.resolve("web/useCases/historyUseCases.js"),
    "utf8",
  );

  assert.match(dtoSource, /historyId/);
  assert.match(dtoSource, /jobId/);
  assert.match(dtoSource, /historyUrl/);
  assert.match(historyUseCaseSource, /service\.getHistoryDetails\(command\.id, command\.lang\)/);
  assert.match(historyUseCaseSource, /service\.getHistorySummary\(command\.id, command\.lang\)/);
  assert.match(historyUseCaseSource, /service\.getHistoryEditChanges\(\s*command\.id,\s*command\.cursor,\s*command\.limit,\s*\)/);
  assert.doesNotMatch(historyUseCaseSource, /service\.getHistorySummary\(\{\s*shop:/);
});

test("run edit preview ownership is shop-scoped and actor matching is optional", () => {
  const commandSource = fs.readFileSync(
    path.resolve("web/services/bulkEdit/BulkEditCommandService.js"),
    "utf8",
  );
  const previewSource = fs.readFileSync(
    path.resolve("web/services/productService/ProductBulkPreviewService.js"),
    "utf8",
  );
  const repositorySource = fs.readFileSync(
    path.resolve("web/repositories/bulkEditCommandRepository.js"),
    "utf8",
  );
  const scheduledSource = fs.readFileSync(
    path.resolve("web/services/productService/ScheduledEditService.js"),
    "utf8",
  );

  assert.match(commandSource, /const previewShop = String\(/);
  assert.match(commandSource, /fingerprint\.owner\?\.shop/);
  assert.match(commandSource, /previewActorId && executionActorId && executionActorId !== previewActorId/);
  assert.doesNotMatch(commandSource, /throw new Error\("PREVIEW_OWNERSHIP_UNBOUND"\)/);
  assert.doesNotMatch(commandSource, /throw new Error\("ACTOR_ID_REQUIRED_FOR_EXECUTE"\)/);
  assert.match(scheduledSource, /const previewShop = String\(/);
  assert.match(scheduledSource, /fingerprint\.owner\?\.shop/);
  assert.match(scheduledSource, /previewActorId && executionActorId && previewActorId !== executionActorId/);
  assert.doesNotMatch(scheduledSource, /throw new Error\("PREVIEW_OWNERSHIP_UNBOUND"\)/);
  assert.doesNotMatch(scheduledSource, /throw new Error\("ACTOR_ID_REQUIRED_FOR_SCHEDULE"\)/);
  assert.match(previewSource, /shop: this\.session\.shop/);
  assert.match(previewSource, /previewSignature = `sig_\$\{previewSignatureHash\.slice\(0, 12\)\}`/);
  assert.match(repositorySource, /source: "manual_preview"/);
});

test("run edit requires executable preview rows before queuing", () => {
  const commandSource = fs.readFileSync(
    path.resolve("web/services/bulkEdit/BulkEditCommandService.js"),
    "utf8",
  );

  assert.match(commandSource, /NO_READY_PREVIEW_ROWS/);
  assert.match(commandSource, /NO_MATCHING_TARGETS/);
  assert.match(commandSource, /!row\?\.plannedMutation\?\.jsonlRow/);
  assert.match(commandSource, /filterAst: null/);
});

test("direct variant execution uses supported Shopify bulk update mutation", () => {
  const commandSource = fs.readFileSync(
    path.resolve("web/services/bulkEdit/BulkEditCommandService.js"),
    "utf8",
  );

  assert.match(commandSource, /PRODUCT_VARIANTS_BULK_UPDATE_MUTATION/);
  assert.match(commandSource, /productVariantsBulkUpdate\(productId: \$productId, variants: \$variants\)/);
  assert.match(commandSource, /ProductVariantsBulkInput/);
  assert.doesNotMatch(commandSource, /productVariantUpdate/);
});

test("preview mirror gate allows degraded active mirrors while execution remains strict", () => {
  const source = fs.readFileSync(
    path.resolve("web/services/mirrorHealthService.js"),
    "utf8",
  );

  assert.match(source, /isPreviewLike/);
  assert.match(source, /\["UNSAFE", "REPAIR_REQUIRED"\]\.includes\(mirrorHealthState\)/);
  assert.match(source, /\["UNSAFE", "DEGRADED", "REPAIR_REQUIRED"\]\.includes\(mirrorHealthState\)/);
  assert.match(source, /!isPreviewLike &&\s*\(\s*state\?\.isProductInitialySyning === true \|\| state\?\.shopifyBulkJobCompleted === false\s*\)/);
  assert.match(source, /!isPreviewLike &&\s*\(\s*state\?\.isProductSyncing === true \|\| state\?\.isCollectionSyncing === true\s*\)/);
});
