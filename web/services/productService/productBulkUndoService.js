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
import { prisma } from "../../config/database.js";
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


const OPTION_NAME_FIELDS = new Set([
  "option1Name",
  "option2Name",
  "option3Name",
]);

class UndoEditService {
  constructor(session) {
    this.client = new shopify.api.clients.Graphql({ session });
    this.session = session;
    this.idempotencyStore = new IdempotencyStoreService(prisma);
  }

  async undoEdit(historyId, options = {}) {
    const idempotencyKey = String(options?.idempotencyKey || "").trim();
    if (!idempotencyKey) {
      const error = new Error("IDEMPOTENCY_KEY_REQUIRED");
      error.code = "VALIDATION_FAILED";
      throw error;
    }
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
      return begin.response;
    }

    const editedHistory = await prisma.editHistory.findFirst({
      where: {
        id: historyId,
        shop: this.session.shop,
      },
      select: {
        id: true,
        status: true,
        undo: true,
        batch: true,
        executionState: true,
      },
    });

    if (!editedHistory) {
      throw new Error("Edit history not found");
    }

    const undoData = normalizeUndoState(
      editedHistory.undo,
      buildPlannedUndoState({ allowed: false }),
    );

    if (!["completed", "partial"].includes(String(editedHistory.status || "").toLowerCase()) || undoData.allowed === false) {
      throw new Error("Undo can only be performed on completed or partially completed edits");
    }
    const operationKey =
      editedHistory?.batch?.operationKey ||
      editedHistory?.batch?.executionPlan?.operationKey ||
      null;
    if (operationKey) {
      const operationDef = ProductEditOperationRegistry.PRODUCT_EDIT_OPERATIONS[operationKey] || null;
      if (operationDef && operationDef.undoable === false) {
        throw new Error("Undo is not supported for this operation type");
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
      throw new Error("Undo is already queued or completed");
    }

    const snapshotSetId = String(
      editedHistory?.batch?.targetSnapshotRef?.snapshotSetId || "",
    ).trim();
    const snapshotOperationId = String(
      editedHistory?.batch?.targetSnapshotRef?.operationId || "",
    ).trim();
    if (!snapshotSetId) {
      throw new Error("FROZEN_SNAPSHOT_SET_REQUIRED_FOR_UNDO");
    }
    const snapshotSet = await getFrozenSnapshotSetForExecution({
      shop: this.session.shop,
      snapshotSetId,
      operationId: snapshotOperationId || undefined,
      db: prisma,
    });
    const eligibleCount = await prisma.targetSnapshotItem.count({
      where: {
        shop: this.session.shop,
        snapshotSetId: snapshotSet.id,
        executionStatus: { in: ["SUCCEEDED", "VERIFIED"] },
      },
    });
    if (eligibleCount <= 0) {
      throw new Error("UNDO_ELIGIBLE_TARGETS_NOT_FOUND");
    }

    const executionIdentity = undoData.executionIdentity || crypto.randomUUID();
    const idempotencyKeyHash = crypto
      .createHash("sha256")
      .update(idempotencyKey)
      .digest("hex");

    const undoOperation = await prisma.undoOperation.upsert({
      where: {
        shop_sourceEditHistoryId: {
          shop: this.session.shop,
          sourceEditHistoryId: historyId,
        },
      },
      create: {
        shop: this.session.shop,
        sourceEditHistoryId: historyId,
        executionIdentity,
        idempotencyKeyHash,
        status: "pending",
        state: "queued",
        totalEligibleCount: Number(eligibleCount || 0),
      },
      update: {},
    });

    const updatedHistory = await prisma.editHistory.updateMany({
      where: {
        id: historyId,
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
            computedAt: new Date().toISOString(),
          },
        },
      },
    });

    if (!updatedHistory.count) {
      throw new Error("Undo could not be queued");
    }

    await clearKeyCaches(`${this.session.shop}:fetchHistories`);
    await clearKeyCaches(`${this.session.shop}:historyDetails:${historyId}`);

    await addbulkUndoJob({
      historyId,
      shop: this.session.shop,
      source: "manual_undo",
      executionId: executionIdentity,
    });

    const response = {
      data: { id: historyId },
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
        payload.productOptions = productOptions.map((option) => ({
          name: option.name,
          values: option.values?.map((value) => ({ name: value })),
        }));

        payload.variants = variantFieldChanges.map((variant) => {
          const variantPayload = {
            id: variant.variantId,
            optionValues: (() => {
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
            })(),
          };

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
      throw new Error(`Shopify API returned errors: ${JSON.stringify(userErrors)}`);
    }

    const target = stagedRes?.body?.data?.stagedUploadsCreate?.stagedTargets?.[0];
    if (!target) {
      throw new Error("Failed to get staged upload target from Shopify");
    }

    const keyUrl = await uploadToShopifyStagedTarget(target, ndjson);

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
      throw new Error(`Bulk operation returned errors: ${JSON.stringify(bulkErrors)}`);
    }

    const result = bulkRes.body?.data?.bulkOperationRunMutation;

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
          : null;
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
        : [];
      const beforeVariantFieldChanges = Array.isArray(beforeValues.variantFieldChanges)
        ? beforeValues.variantFieldChanges
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
