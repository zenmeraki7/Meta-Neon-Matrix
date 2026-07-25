import crypto from "crypto";
import { uploadToShopifyStagedTarget } from "../../utils/productBulkEditUtils.js";
import {
  getProductSetMutation,
  PRODUCT_SET_MODE,
} from "../../helpers/productBulkOperationHelpers/mutationTemplates.js";
import shopify from "../../shopify.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
import { FIELD_CONFIGS } from "../../helpers/productBulkOperationHelpers/constants.js";
import { db } from "../../repositories/repositoryDb.js";
import {
  BULK_UNDO_STATES,
  buildPlannedUndoState,
  normalizeUndoState,
} from "../bulkEditExecutionStateService.js";
import { ProductEditOperationRegistry } from "../bulkEdit/planner/productEditOperationRegistry.js";
import logger from "../../utils/loggerUtils.js";
import { refreshTargetSnapshotSetCounters } from "../../repositories/targetSnapshotSetRepository.js";

const OPTION_NAME_FIELDS = new Set([
  "option1Name",
  "option2Name",
  "option3Name",
]);
const SUCCESSFUL_CHANGE_STATUSES = [
  "SUCCESS",
  "SUCCEEDED",
  "VERIFIED",
  "success",
  "succeeded",
  "verified",
];
const ACTIVE_UNDO_STATES = new Set([
  "requested",
  "queued",
  "applying",
  "dispatching",
  "awaiting_shopify",
  "verifying",
  "finalizing",
]);
const TERMINAL_UNDO_STATES = new Set([
  "completed",
  "partially_completed",
  "partial",
  "failed",
  "cancelled",
]);
const TRANSACTION_RETRY_LIMIT = 3;

function buildUndoError(code, message, details = {}) {
  const error = new Error(message || code);
  error.code = code;
  error.details = details;
  return error;
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function stableHash(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function canonicalComparable(field, value) {
  if (value === undefined) return { kind: "absent" };
  if (value === null) return { kind: "null" };
  if (field === "tags" && Array.isArray(value)) {
    return { kind: "set", value: [...value].map(String).sort() };
  }
  if (["price", "compareAtPrice"].includes(field)) {
    const number = Number(value);
    return Number.isFinite(number)
      ? {
          kind: "decimal",
          value: number.toFixed(6).replace(/0+$/, "").replace(/\.$/, ""),
        }
      : { kind: "string", value: String(value) };
  }
  return { kind: typeof value, value };
}

function currentNodeValue(node, field) {
  if (field === "Meta Title" || field === "metaTitle") return node?.seo?.title;
  if (field === "Meta Description" || field === "metaDescription")
    return node?.seo?.description;
  if (field === "description") return node?.descriptionHtml;
  if (field === "inventory") return node?.inventoryQuantity;
  return node?.[field];
}

function valuesMatch(field, current, expected) {
  return (
    stableHash(canonicalComparable(field, current)) ===
    stableHash(canonicalComparable(field, expected))
  );
}

function isDatabaseUnavailable(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();
  return (
    ["P1000", "P1001", "P1002", "P1008", "P1017"].includes(code) ||
    message.includes("can't reach database") ||
    message.includes("connection terminated") ||
    message.includes("connection refused")
  );
}

function toUndoResponse(operation, { idempotent = false } = {}) {
  return {
    ok: true,
    undoExecutionId: operation.id,
    status: String(operation.executionState || "queued").toUpperCase(),
    idempotent,
  };
}

class UndoEditService {
  constructor(session) {
    this.client = new shopify.api.clients.Graphql({ session });
    this.session = session;
  }

  async undoEdit(historyId, options = {}) {
    const idempotencyKey = String(options?.idempotencyKey || "").trim();
    if (!idempotencyKey) {
      throw buildUndoError(
        "IDEMPOTENCY_KEY_REQUIRED",
        "IDEMPOTENCY_KEY_REQUIRED",
        {
          operationId: historyId,
          shop: this.session.shop,
        }
      );
    }

    const requestedHistoryId = String(historyId || "").trim();
    if (!requestedHistoryId || requestedHistoryId.includes("...")) {
      throw buildUndoError(
        "INVALID_HISTORY_ID",
        "A full immutable history id is required"
      );
    }
    const confirmationOperationId = String(
      options?.confirmationOperationId || ""
    ).trim();
    if (confirmationOperationId !== requestedHistoryId) {
      throw buildUndoError(
        "INVALID_OPERATION_ID",
        "Operation confirmation does not match the requested history"
      );
    }

    const executionIdentity = crypto.randomUUID();
    const idempotencyKeyHash = stableHash(idempotencyKey);
    const requestedAt = new Date();
    logger.info("undo.http.claim_started", {
      shop: this.session.shop,
      originalHistoryId: requestedHistoryId,
    });
    for (let attempt = 1; attempt <= TRANSACTION_RETRY_LIMIT; attempt += 1) {
      try {
        const result = await db.$transaction(
          async (tx) => {
            const history = await tx.editHistory.findFirst({
              where: { id: requestedHistoryId, shop: this.session.shop },
              select: {
                id: true,
                status: true,
                statusNormalized: true,
                executionState: true,
                executionStateNormalized: true,
                executionIdentity: true,
                undo: true,
                batch: true,
              },
            });
            if (!history) {
              throw buildUndoError(
                "UNDO_HISTORY_NOT_FOUND",
                "Edit history not found"
              );
            }

            const existing = await tx.undoOperation.findUnique({
              where: {
                shop_sourceEditHistoryId: {
                  shop: this.session.shop,
                  sourceEditHistoryId: history.id,
                },
              },
            });
            if (existing) {
              const state = String(existing.executionState || "").toLowerCase();
              if (
                ACTIVE_UNDO_STATES.has(state) ||
                TERMINAL_UNDO_STATES.has(state)
              ) {
                return toUndoResponse(existing, { idempotent: true });
              }
            }

            const undoData = normalizeUndoState(
              history.undo,
              buildPlannedUndoState({ allowed: false })
            );
            const status = String(
              history.statusNormalized || history.status || ""
            ).toLowerCase();
            const executionState = String(
              history.executionStateNormalized || history.executionState || ""
            ).toLowerCase();
            if (
              !["completed", "partial"].includes(status) &&
              !["completed", "partial_failed"].includes(executionState)
            ) {
              throw buildUndoError(
                "UNDO_NOT_ALLOWED",
                "This edit cannot be undone in its current state"
              );
            }
            const operationKey =
              history?.batch?.operationKey ||
              history?.batch?.executionPlan?.operationKey ||
              null;
            if (undoData.allowed === false) {
              throw buildUndoError(
                operationKey === "CSV_IMPORT_SET"
                  ? "CSV_CREATE_UNDO_NOT_SUPPORTED"
                  : "UNDO_NOT_ALLOWED",
                operationKey === "CSV_IMPORT_SET"
                  ? "CSV imports that created products cannot be safely undone"
                  : "This edit is not marked undoable"
              );
            }

            const operationDefinition = operationKey
              ? ProductEditOperationRegistry.PRODUCT_EDIT_OPERATIONS[
                  operationKey
                ]
              : null;
            if (operationDefinition?.undoable === false) {
              throw buildUndoError(
                "UNDO_NOT_ALLOWED",
                "This edit family cannot be safely undone"
              );
            }

            const successfulChanges = await tx.changeRecord.findMany({
              where: {
                shop: this.session.shop,
                editHistoryId: history.id,
                status: { in: SUCCESSFUL_CHANGE_STATUSES },
              },
              select: {
                targetIdentity: true,
                beforeValues: true,
                productFieldChanges: true,
                variantFieldChanges: true,
                options: true,
              },
            });
            const containsCsvCreates = successfulChanges.some(
              (record) => normalizeObject(record.options).csvCreate === true
            );
            if (containsCsvCreates) {
              throw buildUndoError(
                "CSV_CREATE_UNDO_NOT_SUPPORTED",
                "CSV imports that created products cannot be safely undone"
              );
            }
            const appliedChanges = successfulChanges;
            if (!appliedChanges.length) {
              throw buildUndoError(
                "UNDO_ELIGIBLE_TARGETS_NOT_FOUND",
                "No applied items can be undone"
              );
            }

            const snapshotSetId = String(
              history?.batch?.targetSnapshotRef?.snapshotSetId || ""
            ).trim();
            let snapshotSource = "change_record_before_values";
            if (snapshotSetId) {
              snapshotSource = "target_snapshot";
              const undoableTargetKeys = appliedChanges
                .map((record) => String(record.targetIdentity || "").trim())
                .filter(Boolean);
              const snapshotCount = await tx.targetSnapshotItem.count({
                where: {
                  shop: this.session.shop,
                  snapshotSetId,
                  targetKey: { in: undoableTargetKeys },
                  executionStatus: "SUCCEEDED",
                },
              });
              if (snapshotCount !== undoableTargetKeys.length) {
                throw buildUndoError(
                  "UNDO_SNAPSHOTS_INCOMPLETE",
                  "Trusted before-state snapshots are incomplete"
                );
              }
              await tx.targetSnapshotItem.updateMany({
                where: {
                  shop: this.session.shop,
                  snapshotSetId,
                  targetKey: { in: undoableTargetKeys },
                  executionStatus: "SUCCEEDED",
                  undoStatus: "NOT_REQUIRED",
                },
                data: { undoStatus: "PENDING" },
              });
              await refreshTargetSnapshotSetCounters({
                shop: this.session.shop,
                snapshotSetId,
                db: tx,
              });
            } else {
              const incomplete = appliedChanges.some(
                (record) =>
                  record.beforeValues == null &&
                  record.productFieldChanges == null &&
                  record.variantFieldChanges == null
              );
              if (incomplete) {
                throw buildUndoError(
                  "UNDO_SNAPSHOTS_INCOMPLETE",
                  "Trusted before-state snapshots are incomplete"
                );
              }
            }

            const operation = await tx.undoOperation.create({
              data: {
                shop: this.session.shop,
                sourceEditHistoryId: history.id,
                executionIdentity,
                idempotencyKeyHash,
                outcomeStatus: "pending",
                executionState: "queued",
                totalEligibleCount: appliedChanges.length,
                requestedAt,
              },
            });
            const commandJson = {
              version: 1,
              shop: this.session.shop,
              sourceEditHistoryId: history.id,
              undoExecutionId: operation.id,
              executionIdentity,
              snapshotSource,
              snapshotSetId: snapshotSetId || null,
              requestedAt: requestedAt.toISOString(),
            };
            await tx.undoCommand.create({
              data: {
                shop: this.session.shop,
                undoOperationId: operation.id,
                sourceEditHistoryId: history.id,
                commandHash: stableHash(commandJson),
                commandJson,
              },
            });
            await tx.outboxEvent.create({
              data: {
                shop: this.session.shop,
                aggregateType: "UNDO_EXECUTION",
                aggregateId: operation.id,
                domainEventType: "UNDO_REQUESTED",
                eventDedupeKey: `undo-requested:${operation.id}`,
                payloadJson: {
                  historyId: history.id,
                  shop: this.session.shop,
                  source: "manual_undo_outbox",
                  executionId: executionIdentity,
                  undoExecutionId: operation.id,
                },
                status: "PENDING",
              },
            });

            const moved = await tx.editHistory.updateMany({
              where: {
                id: history.id,
                shop: this.session.shop,
                status: { in: ["completed", "partial"] },
              },
              data: {
                undo: {
                  ...undoData,
                  outcomeStatus: "pending",
                  executionState: BULK_UNDO_STATES.QUEUED,
                  queuedAt: requestedAt,
                  executionIdentity,
                  undoOperationId: operation.id,
                  processedCount: 0,
                  error: null,
                  eligibility: {
                    sourceStatuses: SUCCESSFUL_CHANGE_STATUSES,
                    eligibleCount: appliedChanges.length,
                    snapshotSource,
                    snapshotSetId: snapshotSetId || null,
                    computedAt: requestedAt.toISOString(),
                  },
                },
              },
            });
            if (moved.count !== 1) {
              throw buildUndoError(
                "UNDO_QUEUE_TRANSITION_REJECTED",
                "Undo claim lost a lifecycle race"
              );
            }
            return toUndoResponse(operation);
          },
          { isolationLevel: "Serializable" }
        );

        logger.info("undo.http.claimed", {
          shop: this.session.shop,
          originalHistoryId: requestedHistoryId,
          undoExecutionId: result.undoExecutionId,
          idempotent: result.idempotent,
        });
        await clearKeyCaches(`${this.session.shop}:fetchHistories`).catch(
          () => {}
        );
        await clearKeyCaches(
          `${this.session.shop}:historyDetails:${requestedHistoryId}`
        ).catch(() => {});
        return result;
      } catch (error) {
        if (error?.code === "P2002") {
          const existing = await db.undoOperation.findUnique({
            where: {
              shop_sourceEditHistoryId: {
                shop: this.session.shop,
                sourceEditHistoryId: requestedHistoryId,
              },
            },
          });
          if (existing) return toUndoResponse(existing, { idempotent: true });
        }
        if (error?.code === "P2034" && attempt < TRANSACTION_RETRY_LIMIT)
          continue;
        if (isDatabaseUnavailable(error)) {
          throw buildUndoError(
            "DATABASE_UNAVAILABLE",
            "Undo database is temporarily unavailable"
          );
        }
        throw error;
      }
    }
    throw buildUndoError(
      "DATABASE_UNAVAILABLE",
      "Undo database transaction could not be completed"
    );
  }

  async undoEditBulkOperation(products, field = "") {
    const commandType = `bulkEditUndoProducts_${Date.now()}`;
    const formattedProducts = [];
    let lastId = null;
    let count = 0;
    let mode = PRODUCT_SET_MODE.PRODUCT_ONLY;

    if (!field || field === "mixed") {
      mode = PRODUCT_SET_MODE.BOTH;
    } else if (OPTION_NAME_FIELDS.has(field)) {
      mode = PRODUCT_SET_MODE.BOTH;
    } else if (FIELD_CONFIGS[field]?.isVariantLevel) {
      mode = PRODUCT_SET_MODE.VARIANT_ONLY;
    } else {
      mode = PRODUCT_SET_MODE.PRODUCT_ONLY;
    }

    for (const product of products) {
      const productFieldChanges = Array.isArray(product?.productFieldChanges)
        ? product.productFieldChanges
        : [];
      const variantFieldChanges = Array.isArray(product?.variantFieldChanges)
        ? product.variantFieldChanges
        : [];
      const productOptions = Array.isArray(product?.options)
        ? product.options
        : [];

      const payload = {
        id: product.productId,
      };

      if (productFieldChanges.length > 0) {
        productFieldChanges.forEach((fieldChange) => {
          if (!OPTION_NAME_FIELDS.has(fieldChange.field)) {
            Object.assign(
              payload,
              this.getProductFieldPayload(
                fieldChange.field,
                fieldChange.revertValue,
                fieldChange.oldValue
              )
            );
          }
        });
      }

      if (variantFieldChanges.length > 0) {
        if (productOptions.length > 0) {
          payload.productOptions = productOptions.map((option) => ({
            name: option.name,
            values: option.values?.map((value) => ({ name: value })),
          }));
        }

        payload.variants = variantFieldChanges.map((variant) => {
          const variantPayload = {
            id: variant.variantId,
          };

          const optionValues = (() => {
            if (
              Array.isArray(variant.selectedOptions) &&
              variant.selectedOptions.length
            ) {
              return variant.selectedOptions.map((option) => ({
                optionName: option.name,
                name: option.value,
              }));
            }

            return productOptions
              .map((option, index) => {
                const value =
                  variant[`option${index + 1}Value`] ??
                  variant[`option${index + 1}`];
                if (!value) return null;
                return {
                  optionName: option.name,
                  name: value,
                };
              })
              .filter(Boolean);
          })();

          if (optionValues.length > 0) {
            variantPayload.optionValues = optionValues;
          }

          const changePayload =
            variant.changes?.reduce((accumulator, fieldChange) => {
              accumulator[fieldChange.field] =
                fieldChange.revertValue ?? fieldChange.oldValue;
              return accumulator;
            }, {}) || {};

          if (
            ["option1Values", "option2Values", "option3Values"].includes(field)
          ) {
            return variantPayload;
          }

          return { ...variantPayload, ...changePayload };
        });
      }

      formattedProducts.push(JSON.stringify({ productSet: payload }));
      lastId = product?.id;
      count += 1;
    }

    const stagedRes = await this.client.request(`
          mutation stagedUploadsCreate {
            stagedUploadsCreate(input: [
              {
                filename: "${commandType}",
                mimeType: "text/jsonl",
                resource: BULK_MUTATION_VARIABLES,
                httpMethod: POST
              }
            ]) {
              stagedTargets {
                url
                resourceUrl
                parameters { name value }
              }
              userErrors { field message }
            }
          }
        `);

    const ndjson = formattedProducts.join("\n");
    const stagedTopLevelErrors =
      stagedRes?.errors || stagedRes?.body?.errors || [];
    if (stagedTopLevelErrors.length) {
      throw buildUndoError(
        "SHOPIFY_UNDO_STAGED_UPLOAD_FAILED",
        stagedTopLevelErrors[0]?.message ||
          "Shopify staged upload request failed"
      );
    }
    const stagedPayload =
      stagedRes?.data?.stagedUploadsCreate ||
      stagedRes?.body?.data?.stagedUploadsCreate;
    const userErrors = stagedPayload?.userErrors;
    if (userErrors?.length) {
      throw buildUndoError(
        "SHOPIFY_UNDO_STAGED_UPLOAD_FAILED",
        "Shopify staged upload returned errors",
        {
          userErrors,
          count,
          lastProductId: lastId,
        }
      );
    }

    const target = stagedPayload?.stagedTargets?.[0];
    if (!target) {
      throw buildUndoError(
        "SHOPIFY_UNDO_STAGED_UPLOAD_TARGET_MISSING",
        "Failed to get staged upload target from Shopify",
        {
          count,
          lastProductId: lastId,
        }
      );
    }

    const keyUrl = await uploadToShopifyStagedTarget(target, ndjson);
    logger.info("Undo staged upload completed", {
      source: "UndoEditService.undoEditBulkOperation",
      shop: this.session.shop,
      count,
      lastProductId: lastId,
      mode,
    });

    const bulkRes = await this.client.request(`
          mutation {
            bulkOperationRunMutation(
              mutation: ${JSON.stringify(getProductSetMutation(mode))},
              stagedUploadPath: "${keyUrl}"
            ) {
              bulkOperation { id status }
              userErrors { field message }
            }
          }
        `);

    const bulkTopLevelErrors = bulkRes?.errors || bulkRes?.body?.errors || [];
    if (bulkTopLevelErrors.length) {
      throw buildUndoError(
        "SHOPIFY_UNDO_BULK_MUTATION_FAILED",
        bulkTopLevelErrors[0]?.message || "Shopify bulk undo request failed"
      );
    }
    const bulkPayload =
      bulkRes?.data?.bulkOperationRunMutation ||
      bulkRes?.body?.data?.bulkOperationRunMutation;
    const bulkErrors = bulkPayload?.userErrors;
    if (bulkErrors?.length) {
      throw buildUndoError(
        "SHOPIFY_UNDO_BULK_MUTATION_FAILED",
        "Shopify bulk operation returned errors",
        {
          userErrors: bulkErrors,
          count,
          lastProductId: lastId,
        }
      );
    }

    const result = bulkPayload;
    if (!result?.bulkOperation?.id) {
      throw buildUndoError(
        "SHOPIFY_UNDO_BULK_OPERATION_MISSING",
        "Shopify did not return an undo bulk operation id",
        {
          count,
          lastProductId: lastId,
        }
      );
    }

    logger.info("Undo Shopify bulk mutation submitted", {
      source: "UndoEditService.undoEditBulkOperation",
      shop: this.session.shop,
      count,
      lastProductId: lastId,
      mode,
      shopifyBulkOperationId: result?.bulkOperation?.id || null,
      bulkOperationStatus: result?.bulkOperation?.status || null,
    });

    return {
      shopifyBulkOperationId: result?.bulkOperation?.id,
      lastProductId: lastId,
      count,
    };
  }

  async verifyUndoConflicts(products = []) {
    const conflicts = [];
    const observations = [];
    const productIds = [
      ...new Set(products.map((p) => p?.productId).filter(Boolean)),
    ];
    const variantIds = [
      ...new Set(
        products.flatMap((p) =>
          Array.isArray(p?.variantFieldChanges)
            ? p.variantFieldChanges.map((v) => v?.variantId).filter(Boolean)
            : []
        )
      ),
    ];
    const ids = [...new Set([...productIds, ...variantIds])];
    if (!ids.length) return { safeProducts: products, conflicts };

    const response = await this.client.request(
      `#graphql
          query UndoVerifyNodes($ids: [ID!]!) {
            nodes(ids: $ids) {
              __typename
              id
              ... on Product {
                title
                descriptionHtml
                handle
                vendor
                productType
                status
                tags
                seo { title description }
              }
              ... on ProductVariant {
                title
                sku
                barcode
                price
                compareAtPrice
                inventoryQuantity
                inventoryPolicy
                taxable
              }
            }
          }
        `,
      {
        variables: { ids },
      }
    );

    const topLevelErrors = response?.errors || response?.body?.errors || [];
    if (topLevelErrors.length) {
      throw buildUndoError(
        "SHOPIFY_UNDO_VERIFICATION_READ_FAILED",
        topLevelErrors[0]?.message || "Shopify verification read failed"
      );
    }
    const nodes = response?.data?.nodes || response?.body?.data?.nodes || [];
    const nodeMap = new Map(
      nodes.filter(Boolean).map((n) => [String(n.id), n])
    );

    const safeProducts = [];
    for (const record of products) {
      let hasConflict = false;
      for (const fieldChange of Array.isArray(record?.productFieldChanges)
        ? record.productFieldChanges
        : []) {
        const node = nodeMap.get(String(record.productId));
        const field = String(fieldChange?.field || "");
        if (!node || node.__typename !== "Product") {
          hasConflict = true;
          observations.push({
            targetIdentity: record.targetIdentity,
            scope: "product",
            productId: record.productId,
            variantId: null,
            field,
            expectedValue: fieldChange?.newValue,
            currentShopifyValue: null,
            verified: false,
          });
          conflicts.push({
            targetIdentity: record.targetIdentity,
            field,
            code: "UNDO_RESOURCE_UNAVAILABLE",
          });
          continue;
        }
        const expectedAfter = fieldChange?.newValue;
        const current = currentNodeValue(node, field);
        const verified =
          !Object.hasOwn(fieldChange || {}, "newValue") ||
          valuesMatch(field, current, expectedAfter);
        observations.push({
          targetIdentity: record.targetIdentity,
          scope: "product",
          productId: record.productId,
          variantId: null,
          field,
          expectedValue: expectedAfter,
          currentShopifyValue: current,
          verified,
        });
        if (Object.hasOwn(fieldChange || {}, "newValue") && !verified) {
          hasConflict = true;
          conflicts.push({
            targetIdentity: record.targetIdentity,
            field,
            expectedAfter,
            current,
          });
        }
      }
      for (const variantChange of Array.isArray(record?.variantFieldChanges)
        ? record.variantFieldChanges
        : []) {
        const node = nodeMap.get(String(variantChange?.variantId));
        if (!node || node.__typename !== "ProductVariant") {
          hasConflict = true;
          for (const fieldChange of Array.isArray(variantChange?.changes)
            ? variantChange.changes
            : [variantChange]) {
            observations.push({
              targetIdentity: record.targetIdentity,
              scope: "variant",
              productId: record.productId,
              variantId: variantChange?.variantId || null,
              field: String(fieldChange?.field || ""),
              expectedValue: fieldChange?.newValue,
              currentShopifyValue: null,
              verified: false,
            });
          }
          conflicts.push({
            targetIdentity: record.targetIdentity,
            field: null,
            code: "UNDO_RESOURCE_UNAVAILABLE",
          });
          continue;
        }
        const changes = Array.isArray(variantChange?.changes)
          ? variantChange.changes
          : [variantChange];
        for (const fieldChange of changes) {
          const field = String(fieldChange?.field || "");
          const expectedAfter = fieldChange?.newValue;
          const current = currentNodeValue(node, field);
          const verified =
            !Object.hasOwn(fieldChange || {}, "newValue") ||
            valuesMatch(field, current, expectedAfter);
          observations.push({
            targetIdentity: record.targetIdentity,
            scope: "variant",
            productId: record.productId,
            variantId: variantChange?.variantId || null,
            field,
            expectedValue: expectedAfter,
            currentShopifyValue: current,
            verified,
          });
          if (Object.hasOwn(fieldChange || {}, "newValue") && !verified) {
            hasConflict = true;
            conflicts.push({
              targetIdentity: record.targetIdentity,
              field,
              expectedAfter,
              current,
            });
          }
        }
      }
      if (!hasConflict) {
        safeProducts.push(record);
      }
    }

    return { safeProducts, conflicts, observations };
  }

  async verifyUndoRestored(products = []) {
    const verificationInput = products.map((record) => ({
      ...record,
      productFieldChanges: (record.productFieldChanges || []).map((change) => ({
        ...change,
        newValue: change.revertValue ?? change.oldValue,
      })),
      variantFieldChanges: (record.variantFieldChanges || []).map(
        (variant) => ({
          ...variant,
          changes: (variant.changes || []).map((change) => ({
            ...change,
            newValue: change.revertValue ?? change.oldValue,
          })),
        })
      ),
    }));
    const verifiedAt = new Date().toISOString();
    const { conflicts, observations } = await this.verifyUndoConflicts(
      verificationInput
    );
    return {
      verified: conflicts.length === 0,
      failures: conflicts,
      verifiedAt,
      evidence: observations.map((observation) => ({
        ...observation,
        restoredValue: observation.expectedValue,
        verifiedAt,
      })),
    };
  }

  buildUndoReplayRecords(changeRecords = [], snapshotByIdentity = new Map()) {
    const records = Array.isArray(changeRecords) ? changeRecords : [];
    return records.map((record) => {
      const targetIdentity = String(record?.targetIdentity || "").trim();
      if (!targetIdentity) {
        const error = new Error("UNDO_TARGET_IDENTITY_REQUIRED");
        error.code = "UNDO_TARGET_IDENTITY_REQUIRED";
        error.details = { changeRecordId: record?.id || null };
        throw error;
      }
      const snapshot = snapshotByIdentity.get(targetIdentity) || null;
      const snapshotBeforeValues =
        snapshot?.beforeValues && typeof snapshot.beforeValues === "object"
          ? snapshot.beforeValues
          : normalizeObject(record?.beforeValues);
      if (
        !snapshotBeforeValues ||
        Object.keys(snapshotBeforeValues).length === 0
      ) {
        const error = new Error("UNDO_SNAPSHOT_BEFORE_VALUES_REQUIRED");
        error.code = "UNDO_SNAPSHOT_BEFORE_VALUES_REQUIRED";
        error.details = {
          changeRecordId: record?.id || null,
          targetIdentity,
        };
        throw error;
      }

      const beforeValues =
        record?.beforeValues && typeof record.beforeValues === "object"
          ? record.beforeValues
          : {};
      const trustedPlannedMutation = normalizeObject(
        snapshotBeforeValues?.plannedMutation
      );
      const beforeProductFieldChanges = Array.isArray(
        trustedPlannedMutation.productFieldChanges
      )
        ? trustedPlannedMutation.productFieldChanges
        : Array.isArray(beforeValues.productFieldChanges)
        ? beforeValues.productFieldChanges
        : Array.isArray(record?.productFieldChanges)
        ? record.productFieldChanges
        : [];
      const beforeVariantFieldChanges = Array.isArray(
        trustedPlannedMutation.variantFieldChanges
      )
        ? trustedPlannedMutation.variantFieldChanges
        : Array.isArray(beforeValues.variantFieldChanges)
        ? beforeValues.variantFieldChanges
        : Array.isArray(record?.variantFieldChanges)
        ? record.variantFieldChanges
        : [];

      const trustedProductSet =
        normalizeObject(snapshot?.plannedMutation)?.productSet ||
        trustedPlannedMutation.productSet ||
        {};
      const trustedOptions = Array.isArray(trustedProductSet?.productOptions)
        ? trustedProductSet.productOptions.map((option) => ({
            name: option?.name,
            values: Array.isArray(option?.values)
              ? option.values
                  .map((value) =>
                    typeof value === "object" ? value?.name : value
                  )
                  .filter(Boolean)
              : [],
          }))
        : [];
      const hydratedVariantFieldChanges = beforeVariantFieldChanges.map(
        (variantChange) => {
          const trustedVariant = Array.isArray(trustedProductSet?.variants)
            ? trustedProductSet.variants.find(
                (variant) =>
                  String(variant?.id || "") ===
                  String(variantChange?.variantId || record?.variantId || "")
              )
            : null;
          const selectedOptions = Array.isArray(trustedVariant?.optionValues)
            ? trustedVariant.optionValues
                .map((option) => ({
                  name: option?.optionName,
                  value: option?.name,
                }))
                .filter((option) => option.name && option.value)
            : [];
          return {
            ...variantChange,
            ...(selectedOptions.length ? { selectedOptions } : {}),
          };
        }
      );

      const hasBeforeValues =
        beforeProductFieldChanges.length > 0 ||
        beforeVariantFieldChanges.length > 0;
      if (!hasBeforeValues) {
        const error = new Error("UNDO_BEFORE_VALUES_REQUIRED");
        error.code = "UNDO_BEFORE_VALUES_REQUIRED";
        error.details = {
          changeRecordId: record?.id || null,
          targetIdentity: record?.targetIdentity || null,
        };
        throw error;
      }

      return {
        ...record,
        productFieldChanges: beforeProductFieldChanges,
        variantFieldChanges: hydratedVariantFieldChanges,
        options:
          trustedOptions.length > 0
            ? trustedOptions
            : Array.isArray(record?.options)
            ? record.options
            : [],
        snapshotBeforeValues,
      };
    });
  }

  getProductFieldPayload(field, revertValue, oldValue) {
    const value = revertValue ?? oldValue;

    const fieldMap = {
      description: { descriptionHtml: value ?? "" },
      descriptionHtml: { descriptionHtml: value ?? "" },
      "Meta Title": {
        seo: { title: value },
      },
      "Meta Description": {
        seo: { description: value },
      },
    };

    return fieldMap[field] || { [field]: value };
  }
}

export default UndoEditService;
