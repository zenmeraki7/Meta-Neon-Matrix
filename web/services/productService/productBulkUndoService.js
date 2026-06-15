import crypto from "crypto";
import { uploadToShopifyStagedTarget } from "../../utils/productBulkEditUtils.js";
import { addbulkUndoJob } from "../../Jobs/Queues/bulkUndoJob.js";
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
import {
  buildIdempotencyRequestHash,
  IdempotencyStoreService,
} from "../idempotency/IdempotencyStoreService.js";
import { getFrozenSnapshotSetForExecution } from "../../repositories/targetSnapshotSetRepository.js";
import logger from "../../utils/loggerUtils.js";


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

function buildUndoError(code, message, details = {}) {
  const error = new Error(message || code);
  error.code = code;
  error.details = details;
  return error;
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

class UndoEditService {
  constructor(session) {
    this.client = new shopify.api.clients.Graphql({ session });
    this.session = session;
    this.idempotencyStore = new IdempotencyStoreService(db);
  }

  async undoEdit(historyId, options = {}) {
    const idempotencyKey = String(options?.idempotencyKey || "").trim();
    if (!idempotencyKey) {
      throw buildUndoError("IDEMPOTENCY_KEY_REQUIRED", "IDEMPOTENCY_KEY_REQUIRED", {
        operationId: historyId,
        shop: this.session.shop,
      });
    }

    logger.info("Undo request received", {
      source: "UndoEditService.undoEdit",
      shop: this.session.shop,
      operationId: historyId,
      hasIdempotencyKey: true,
    });

    const begin = await this.idempotencyStore.begin({
      shop: this.session.shop,
      scope: "BULK_EDIT_UNDO",
      key: idempotencyKey,
      requestHash: buildIdempotencyRequestHash({
        shop: this.session.shop,
        historyId,
      }),
    });
    if (begin.mode === "replay") {
      logger.info("Undo idempotency replay returned", {
        source: "UndoEditService.undoEdit",
        shop: this.session.shop,
        operationId: historyId,
      });
      return begin.response;
    }

    const editedHistory = await db.editHistory.findFirst({
      where: {
        shop: this.session.shop,
        OR: [
          { id: historyId },
          { executionIdentity: historyId },
        ],
      },
      select: {
        id: true,
        shop: true,
        status: true,
        statusNormalized: true,
        undo: true,
        batch: true,
        executionState: true,
        executionStateNormalized: true,
        executionIdentity: true,
      },
    });

    if (!editedHistory) {
      throw buildUndoError("UNDO_HISTORY_NOT_FOUND", "Edit history not found", {
        operationId: historyId,
        shop: this.session.shop,
      });
    }

    const sourceHistoryId = editedHistory.id;
    logger.info("Undo operation lookup succeeded", {
      source: "UndoEditService.undoEdit",
      shop: this.session.shop,
      requestedOperationId: historyId,
      historyId: sourceHistoryId,
      executionIdentity: editedHistory.executionIdentity || null,
      status: editedHistory.status,
      executionState: editedHistory.executionState,
    });

    const undoData = normalizeUndoState(
      editedHistory.undo,
      buildPlannedUndoState({ allowed: false }),
    );

    const normalizedStatus = String(editedHistory.status || editedHistory.statusNormalized || "").toLowerCase();
    const normalizedExecutionState = String(
      editedHistory.executionStateNormalized || editedHistory.executionState || "",
    ).toLowerCase();
    const isUndoableTerminal =
      ["completed", "partial"].includes(normalizedStatus) ||
      ["completed", "partial_failed"].includes(normalizedExecutionState);

    if (!isUndoableTerminal || undoData.allowed === false) {
      throw buildUndoError(
        "OPERATION_NOT_UNDOABLE",
        "Undo can only be performed on completed or partially completed edits",
        {
          shop: this.session.shop,
          historyId: sourceHistoryId,
          status: editedHistory.status,
          executionState: editedHistory.executionState,
          undoAllowed: undoData.allowed,
        },
      );
    }
    const operationKey =
      editedHistory?.batch?.operationKey ||
      editedHistory?.batch?.executionPlan?.operationKey ||
      null;
    if (operationKey) {
      const operationDef = ProductEditOperationRegistry.PRODUCT_EDIT_OPERATIONS[operationKey] || null;
      if (operationDef && operationDef.undoable === false) {
        throw buildUndoError("OPERATION_NOT_UNDOABLE", "Undo is not supported for this operation type", {
          shop: this.session.shop,
          historyId: sourceHistoryId,
          operationKey,
        });
      }
    }

    if (
      [
        BULK_UNDO_STATES.QUEUED,
        BULK_UNDO_STATES.DISPATCHING,
        BULK_UNDO_STATES.AWAITING_SHOPIFY,
        BULK_UNDO_STATES.FINALIZING,
        BULK_UNDO_STATES.COMPLETED,
      ].includes(undoData.state)
    ) {
      throw buildUndoError("UNDO_ALREADY_QUEUED", "Undo is already queued or completed", {
        shop: this.session.shop,
        historyId: sourceHistoryId,
        undoState: undoData.state,
      });
    }

    const snapshotSetId = String(
      editedHistory?.batch?.targetSnapshotRef?.snapshotSetId || "",
    ).trim();
    const snapshotOperationId = String(
      editedHistory?.batch?.targetSnapshotRef?.operationId || "",
    ).trim();
    let snapshotSet = null;
    let eligibleCount = 0;
    let snapshotSource = "target_snapshot";

    if (snapshotSetId) {
      snapshotSet = await getFrozenSnapshotSetForExecution({
        shop: this.session.shop,
        snapshotSetId,
        operationId: snapshotOperationId || undefined,
        db: db,
      });
      eligibleCount = await db.targetSnapshotItem.count({
        where: {
          shop: this.session.shop,
          snapshotSetId: snapshotSet.id,
          executionStatus: { in: ["SUCCEEDED", "VERIFIED"] },
          undoStatus: "PENDING",
        },
      });
    } else {
      snapshotSource = "change_record_before_values";
      eligibleCount = await db.changeRecord.count({
        where: {
          shop: this.session.shop,
          editHistoryId: sourceHistoryId,
          status: { in: SUCCESSFUL_CHANGE_STATUSES },
          OR: [
            { beforeValues: { not: null } },
            { productFieldChanges: { not: null } },
            { variantFieldChanges: { not: null } },
          ],
        },
      });
    }

    logger.info("Undo snapshot eligibility resolved", {
      source: "UndoEditService.undoEdit",
      shop: this.session.shop,
      historyId: sourceHistoryId,
      snapshotSource,
      snapshotSetId: snapshotSet?.id || null,
      eligibleCount,
    });

    if (eligibleCount <= 0) {
      throw buildUndoError("UNDO_ELIGIBLE_TARGETS_NOT_FOUND", "UNDO_ELIGIBLE_TARGETS_NOT_FOUND", {
        shop: this.session.shop,
        historyId: sourceHistoryId,
        snapshotSetId: snapshotSet?.id || null,
        snapshotSource,
      });
    }

    const executionIdentity = undoData.executionIdentity || crypto.randomUUID();
    const idempotencyKeyHash = crypto
      .createHash("sha256")
      .update(idempotencyKey)
      .digest("hex");

    const undoOperation = await db.undoOperation.upsert({
      where: {
        shop_sourceEditHistoryId: {
          shop: this.session.shop,
          sourceEditHistoryId: sourceHistoryId,
        },
      },
      create: {
        shop: this.session.shop,
        sourceEditHistoryId: sourceHistoryId,
        executionIdentity,
        idempotencyKeyHash,
        status: "pending",
        state: "queued",
        totalEligibleCount: Number(eligibleCount || 0),
      },
      update: {},
    });

    const updatedHistory = await db.editHistory.updateMany({
      where: {
        id: sourceHistoryId,
        shop: this.session.shop,
        status: { in: ["completed", "partial"] },
      },
      data: {
        undo: {
          ...undoData,
          status: "pending",
          state: BULK_UNDO_STATES.QUEUED,
          queuedAt: new Date(),
          startedAt: null,
          completedAt: null,
          processedCount: 0,
          durationMs: 0,
          bulkOperationId: null,
          executionIdentity,
          undoOperationId: undoOperation.id,
          error: null,
          eligibility: {
            sourceStatuses: ["SUCCESS", "VERIFIED"],
            eligibleCount,
            snapshotSource,
            snapshotSetId: snapshotSet?.id || null,
            computedAt: new Date().toISOString(),
          },
        },
      },
    });

    if (!updatedHistory.count) {
      throw buildUndoError("UNDO_QUEUE_TRANSITION_REJECTED", "Undo could not be queued", {
        shop: this.session.shop,
        historyId: sourceHistoryId,
      });
    }

    await clearKeyCaches(`${this.session.shop}:fetchHistories`);
    await clearKeyCaches(`${this.session.shop}:historyDetails:${sourceHistoryId}`);

    await addbulkUndoJob({
      historyId: sourceHistoryId,
      shop: this.session.shop,
      source: "manual_undo",
      executionId: executionIdentity,
    });

    logger.info("Undo job created", {
      source: "UndoEditService.undoEdit",
      shop: this.session.shop,
      historyId: sourceHistoryId,
      requestedOperationId: historyId,
      undoOperationId: undoOperation.id,
      executionIdentity,
      eligibleCount,
      snapshotSource,
    });

    const response = {
      data: {
        id: sourceHistoryId,
        operationId: editedHistory.executionIdentity || sourceHistoryId,
        undoOperationId: undoOperation.id,
        eligibleCount,
      },
      message: "Undo processing started",
    };
    await this.idempotencyStore.complete({
      recordId: begin.recordId,
      response,
    });
    return response;
  }

  async undoEditBulkOperation(products, field = "") {
    const operationName = `bulkEditUndoProducts_${Date.now()}`;
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
                fieldChange.oldValue,
              ),
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
              if (Array.isArray(variant.selectedOptions) && variant.selectedOptions.length) {
                return variant.selectedOptions.map((option) => ({
                  optionName: option.name,
                  name: option.value,
                }));
              }

              return productOptions
                .map((option, index) => {
                  const value = variant[`option${index + 1}Value`] ?? variant[`option${index + 1}`];
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

          if (["option1Values", "option2Values", "option3Values"].includes(field)) {
            return variantPayload;
          }

          return { ...variantPayload, ...changePayload };
        });
      }

      formattedProducts.push(JSON.stringify({ productSet: payload }));
      lastId = product?.id;
      count += 1;
    }

    const stagedRes = await this.client.query({
      data: {
        query: `
          mutation stagedUploadsCreate {
            stagedUploadsCreate(input: [
              {
                filename: "${operationName}",
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
        `,
      },
    });

    const ndjson = formattedProducts.join("\n");
    const userErrors = stagedRes?.body?.data?.stagedUploadsCreate?.userErrors;
    if (userErrors?.length) {
      throw buildUndoError("SHOPIFY_UNDO_STAGED_UPLOAD_FAILED", "Shopify staged upload returned errors", {
        userErrors,
        count,
        lastProductId: lastId,
      });
    }

    const target = stagedRes?.body?.data?.stagedUploadsCreate?.stagedTargets?.[0];
    if (!target) {
      throw buildUndoError("SHOPIFY_UNDO_STAGED_UPLOAD_TARGET_MISSING", "Failed to get staged upload target from Shopify", {
        count,
        lastProductId: lastId,
      });
    }

    const keyUrl = await uploadToShopifyStagedTarget(target, ndjson);
    logger.info("Undo staged upload completed", {
      source: "UndoEditService.undoEditBulkOperation",
      shop: this.session.shop,
      count,
      lastProductId: lastId,
      mode,
    });

    const bulkRes = await this.client.query({
      data: {
        query: `
          mutation {
            bulkOperationRunMutation(
              mutation: ${JSON.stringify(getProductSetMutation(mode))},
              stagedUploadPath: "${keyUrl}"
            ) {
              bulkOperation { id status }
              userErrors { field message }
            }
          }
        `,
      },
    });

    const bulkErrors = bulkRes?.body?.data?.bulkOperationRunMutation?.userErrors;
    if (bulkErrors?.length) {
      throw buildUndoError("SHOPIFY_UNDO_BULK_MUTATION_FAILED", "Shopify bulk operation returned errors", {
        userErrors: bulkErrors,
        count,
        lastProductId: lastId,
      });
    }

    const result = bulkRes.body?.data?.bulkOperationRunMutation;
    if (!result?.bulkOperation?.id) {
      throw buildUndoError("SHOPIFY_UNDO_BULK_OPERATION_MISSING", "Shopify did not return an undo bulk operation id", {
        count,
        lastProductId: lastId,
      });
    }

    logger.info("Undo Shopify bulk mutation submitted", {
      source: "UndoEditService.undoEditBulkOperation",
      shop: this.session.shop,
      count,
      lastProductId: lastId,
      mode,
      bulkOperationId: result?.bulkOperation?.id || null,
      bulkOperationStatus: result?.bulkOperation?.status || null,
    });

    return {
      bulkOperationId: result?.bulkOperation?.id,
      lastProductId: lastId,
      count,
    };
  }

  async verifyUndoConflicts(products = []) {
    const conflicts = [];
    const productIds = [...new Set(products.map((p) => p?.productId).filter(Boolean))];
    const variantIds = [...new Set(
      products.flatMap((p) => (Array.isArray(p?.variantFieldChanges)
        ? p.variantFieldChanges.map((v) => v?.variantId).filter(Boolean)
        : [])),
    )];
    const ids = [...new Set([...productIds, ...variantIds])];
    if (!ids.length) return { safeProducts: products, conflicts };

    const response = await this.client.query({
      data: {
        query: `#graphql
          query UndoVerifyNodes($ids: [ID!]!) {
            nodes(ids: $ids) {
              __typename
              id
              ... on Product {
                title
                handle
                vendor
                productType
                status
              }
              ... on ProductVariant {
                sku
                barcode
                price
                compareAtPrice
                inventoryQuantity
              }
            }
          }
        `,
        variables: { ids },
      },
    });

    const nodes = response?.body?.data?.nodes || [];
    const nodeMap = new Map(nodes.filter(Boolean).map((n) => [String(n.id), n]));

    const safeProducts = [];
    for (const record of products) {
      let hasConflict = false;
      for (const fieldChange of Array.isArray(record?.productFieldChanges) ? record.productFieldChanges : []) {
        const node = nodeMap.get(String(record.productId));
        if (!node || node.__typename !== "Product") continue;
        const field = String(fieldChange?.field || "");
        const expectedAfter = fieldChange?.newValue;
        const current = node[field] ?? null;
        if (expectedAfter !== undefined && expectedAfter !== null && String(current) !== String(expectedAfter)) {
          hasConflict = true;
          conflicts.push({
            targetIdentity: record.targetIdentity,
            field,
            expectedAfter,
            current,
          });
        }
      }
      for (const variantChange of Array.isArray(record?.variantFieldChanges) ? record.variantFieldChanges : []) {
        const node = nodeMap.get(String(variantChange?.variantId));
        if (!node || node.__typename !== "ProductVariant") continue;
        const field = String(variantChange?.field || "");
        const expectedAfter = variantChange?.newValue;
        const mapField = field === "inventory" ? "inventoryQuantity" : field;
        const current = node[mapField] ?? null;
        if (expectedAfter !== undefined && expectedAfter !== null && String(current) !== String(expectedAfter)) {
          hasConflict = true;
          conflicts.push({
            targetIdentity: record.targetIdentity,
            field,
            expectedAfter,
            current,
          });
        }
      }
      if (!hasConflict) {
        safeProducts.push(record);
      }
    }

    return { safeProducts, conflicts };
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
      if (!snapshotBeforeValues || Object.keys(snapshotBeforeValues).length === 0) {
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
      const beforeProductFieldChanges = Array.isArray(beforeValues.productFieldChanges)
        ? beforeValues.productFieldChanges
        : Array.isArray(record?.productFieldChanges)
          ? record.productFieldChanges
          : [];
      const beforeVariantFieldChanges = Array.isArray(beforeValues.variantFieldChanges)
        ? beforeValues.variantFieldChanges
        : Array.isArray(record?.variantFieldChanges)
          ? record.variantFieldChanges
          : [];

      const hasBeforeValues =
        beforeProductFieldChanges.length > 0 || beforeVariantFieldChanges.length > 0;
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
        variantFieldChanges: beforeVariantFieldChanges,
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

