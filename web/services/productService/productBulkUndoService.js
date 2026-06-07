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


const OPTION_NAME_FIELDS = new Set([
  "option1Name",
  "option2Name",
  "option3Name",
]);

function mirrorFieldValue(row, field) {
  const normalized = String(field || "").replace(/[\s_-]+/g, "").toLowerCase();
  const aliases = {
    description: "descriptionHtml",
    descriptionhtml: "descriptionHtml",
    metatitle: "seoTitle",
    seotitle: "seoTitle",
    metadescription: "seoDescription",
    seodescription: "seoDescription",
    inventory: "inventoryQuantity",
  };
  const key = aliases[normalized] || field;
  return row?.[key] ?? null;
}

function restoredValue(change) {
  return change?.revertValue ?? change?.oldValue ?? change?.newValue ?? null;
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

    const editedHistory = await db.editHistory.findFirst({
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
        targetMirrorBatchId: true,
        type: true,
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
        BULK_UNDO_STATES.CHANGE_RECORDS_PENDING,
        BULK_UNDO_STATES.DISPATCHING,
        BULK_UNDO_STATES.AWAITING_CONFIRMATION,
        BULK_UNDO_STATES.RECONCILE_SUBMITTED,
        BULK_UNDO_STATES.AWAITING_SHOPIFY,
        BULK_UNDO_STATES.FINALIZING,
        BULK_UNDO_STATES.COMPLETED,
      ].includes(undoData.state)
    ) {
      throw new Error("Undo is already queued or completed");
    }

    const sourceIsUndo = String(editedHistory.type || "").toUpperCase() === "UNDO";
    const snapshotSetId = String(
      editedHistory?.batch?.targetSnapshotRef?.snapshotSetId || "",
    ).trim();
    const snapshotOperationId = String(
      editedHistory?.batch?.targetSnapshotRef?.operationId || "",
    ).trim();
    if (!snapshotSetId && !sourceIsUndo) {
      throw new Error("FROZEN_SNAPSHOT_SET_REQUIRED_FOR_UNDO");
    }
    const snapshotSet = sourceIsUndo
      ? null
      : await getFrozenSnapshotSetForExecution({
        shop: this.session.shop,
        snapshotSetId,
        operationId: snapshotOperationId || undefined,
        db: db,
      });
    const eligibleCount = sourceIsUndo
      ? await db.changeRecord.count({
        where: {
          shop: this.session.shop,
          editHistoryId: historyId,
          status: { in: ["SUCCESS", "VERIFIED", "APPLIED"] },
        },
      })
      : await db.targetSnapshotItem.count({
        where: {
          shop: this.session.shop,
          snapshotSetId: snapshotSet.id,
          executionStatus: { in: ["SUCCEEDED", "VERIFIED"] },
          undoStatus: "PENDING",
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

    const { undoOperation, undoEditHistory } = await db.$transaction(async (tx) => {
      const createdUndoHistory = await tx.editHistory.upsert({
        where: { executionIdentity },
        create: {
          shop: this.session.shop,
          executionIdentity,
          sourceEditHistoryId: historyId,
          targetMirrorBatchId: editedHistory.targetMirrorBatchId,
          type: "UNDO",
          status: "pending",
          queryFilter: "",
          startedAt: new Date(),
          totalItems: Number(eligibleCount || 0),
          batch: {
            sourceEditHistoryId: historyId,
            reversibleUndo: true,
          },
          undo: buildPlannedUndoState({ allowed: true }),
        },
        update: {},
      });
      const operation = await tx.undoOperation.upsert({
        where: {
          shop_sourceEditHistoryId: {
            shop: this.session.shop,
            sourceEditHistoryId: historyId,
          },
        },
        create: {
          shop: this.session.shop,
          sourceEditHistoryId: historyId,
          undoEditHistoryId: createdUndoHistory.id,
          executionIdentity,
          idempotencyKeyHash,
          status: "pending",
          state: "queued",
          totalEligibleCount: Number(eligibleCount || 0),
        },
        update: {
          undoEditHistoryId: createdUndoHistory.id,
        },
      });
      return { undoOperation: operation, undoEditHistory: createdUndoHistory };
    });

    const updatedHistory = await db.editHistory.updateMany({
      where: {
        id: historyId,
        shop: this.session.shop,
        status: { in: ["completed", "partial"] },
      },
      data: {
        undo: {
          ...undoData,
          status: "pending",
          state: BULK_UNDO_STATES.CHANGE_RECORDS_PENDING,
          queuedAt: new Date(),
          startedAt: null,
          completedAt: null,
          processedCount: 0,
          durationMs: 0,
          bulkOperationId: null,
          executionIdentity,
          undoOperationId: undoOperation.id,
          undoEditHistoryId: undoEditHistory.id,
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
      shop: this.session.shop,
      response,
    });
    return response;
  }

  async prepareUndoChangeRecords({ undoEditHistoryId, sourceEditHistoryId, products }) {
    const undoHistory = await db.editHistory.findFirst({
      where: { id: undoEditHistoryId, shop: this.session.shop, type: "UNDO" },
      select: { id: true, targetMirrorBatchId: true },
    });
    if (!undoHistory) throw new Error("UNDO_EDIT_HISTORY_NOT_FOUND");
    const mirrorBatchId = String(undoHistory.targetMirrorBatchId || "").trim();
    if (!mirrorBatchId) throw new Error("UNDO_MIRROR_BATCH_REQUIRED");

    const productIds = [...new Set(products.map((record) => String(record.productId || "")).filter(Boolean))];
    const variantIds = [...new Set(products.flatMap((record) =>
      (Array.isArray(record.variantFieldChanges) ? record.variantFieldChanges : [])
        .map((change) => String(change.variantId || ""))
        .filter(Boolean)))];
    const [mirrorProducts, mirrorVariants] = await Promise.all([
      db.product.findMany({ where: { shop: this.session.shop, mirrorBatchId, id: { in: productIds } } }),
      db.variant.findMany({ where: { shop: this.session.shop, mirrorBatchId, id: { in: variantIds } } }),
    ]);
    const productById = new Map(mirrorProducts.map((row) => [String(row.id), row]));
    const variantById = new Map(mirrorVariants.map((row) => [String(row.id), row]));
    const batchId = `undo:${undoEditHistoryId}`;
    const records = products.map((record) => {
      const productMirror = productById.get(String(record.productId || "")) || null;
      const sourceProductChanges = Array.isArray(record.productFieldChanges)
        ? record.productFieldChanges
        : [];
      const sourceVariantChanges = Array.isArray(record.variantFieldChanges)
        ? record.variantFieldChanges
        : [];
      const sourceRecordFailed = String(record?.status || "").toUpperCase() === "FAILED";
      const missingMirror = (sourceProductChanges.length > 0 && !productMirror)
        || sourceVariantChanges.some((change) => !variantById.has(String(change.variantId || "")));
      const hasNoChanges = sourceProductChanges.length === 0 && sourceVariantChanges.length === 0;
      const failureCode = record?.failureCode
        || (missingMirror ? "MIRROR_MISSING" : null)
        || (hasNoChanges ? "UNDO_BEFORE_VALUES_REQUIRED" : null);
      // Phase 1 source-of-truth: undo value_before/beforeValues must come only
      // from the local mirror batch, never from a live Shopify read.
      const beforeProductFieldChanges = sourceProductChanges.map((change) => ({
        field: change.field,
        oldValue: mirrorFieldValue(productMirror, change.field),
        newValue: mirrorFieldValue(productMirror, change.field),
      }));
      const afterProductFieldChanges = sourceProductChanges.map((change) => ({
        field: change.field,
        oldValue: mirrorFieldValue(productMirror, change.field),
        newValue: restoredValue(change),
      }));
      const beforeVariantFieldChanges = sourceVariantChanges.map((change) => {
        const mirror = variantById.get(String(change.variantId || "")) || null;
        return {
          variantId: change.variantId,
          changes: (Array.isArray(change.changes) ? change.changes : [change]).map((entry) => ({
            field: entry.field,
            oldValue: mirrorFieldValue(mirror, entry.field),
            newValue: mirrorFieldValue(mirror, entry.field),
          })),
        };
      });
      const afterVariantFieldChanges = sourceVariantChanges.map((change) => {
        const mirror = variantById.get(String(change.variantId || "")) || null;
        return {
          variantId: change.variantId,
          changes: (Array.isArray(change.changes) ? change.changes : [change]).map((entry) => ({
            field: entry.field,
            oldValue: mirrorFieldValue(mirror, entry.field),
            newValue: restoredValue(entry),
          })),
        };
      });
      return {
        editHistoryId: undoEditHistoryId,
        targetType: String(record.targetType || "PRODUCT").toUpperCase(),
        targetIdentity: String(record.targetIdentity),
        productId: String(record.productId),
        variantId: record.variantId ? String(record.variantId) : null,
        shop: this.session.shop,
        mirrorBatchId,
        beforeValues: {
          productFieldChanges: beforeProductFieldChanges,
          variantFieldChanges: beforeVariantFieldChanges,
        },
        afterValues: {
          productFieldChanges: afterProductFieldChanges,
          variantFieldChanges: afterVariantFieldChanges,
        },
        productFieldChanges: afterProductFieldChanges,
        variantFieldChanges: afterVariantFieldChanges,
        scope: String(record.scope || record.targetType || "product").toLowerCase(),
        status: sourceRecordFailed || missingMirror || hasNoChanges ? "FAILED" : "PENDING",
        failureCode,
        failureMessage: record?.failureMessage
          || (failureCode === "MIRROR_MISSING" ? "Current mirror value required for undo was not found" : null)
          || (failureCode === "UNDO_BEFORE_VALUES_REQUIRED" ? "Undo before-values were missing for this target" : null),
        batchId,
        options: {
          reversibleOperationLog: true,
          operationType: "UNDO",
          sourceEditHistoryId,
        },
      };
    });
    await db.changeRecord.createMany({ data: records, skipDuplicates: true });
    await db.editHistory.updateMany({
      where: { id: undoEditHistoryId, shop: this.session.shop, status: "pending" },
      data: {
        status: "processing",
        statusNormalized: "PROCESSING",
        executionState: "dispatching",
        executionStateNormalized: "DISPATCHING",
      },
    });
    return db.changeRecord.findMany({
      where: {
        shop: this.session.shop,
        editHistoryId: undoEditHistoryId,
        batchId,
        status: { in: ["PENDING", "FAILED"] },
      },
      select: { targetIdentity: true, status: true, failureCode: true },
    });
  }

  async undoEditBulkOperation(products, field = "", options = {}) {
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

    const undoEditHistoryId = String(options?.undoEditHistoryId || "").trim();
    const targetIdentities = [...new Set(
      products.map((product) => String(product?.targetIdentity || "").trim()).filter(Boolean),
    )];
    if (undoEditHistoryId && targetIdentities.length) {
      await db.changeRecord.updateMany({
        where: {
          shop: this.session.shop,
          editHistoryId: undoEditHistoryId,
          targetIdentity: { in: targetIdentities },
          status: "PENDING",
        },
        data: {
          attemptCount: { increment: 1 },
          retryable: true,
          writingStartedAt: new Date(),
        },
      });
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

    // Post-original-write drift check only. This live Shopify read verifies
    // the target still matches the Phase 1 mirror value_before before undoing;
    // it must never populate undo value_before/beforeValues.
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
        const expectedBefore = fieldChange?.oldValue ?? fieldChange?.newValue;
        const current = node[field] ?? null;
        if (expectedBefore !== undefined && expectedBefore !== null && String(current) !== String(expectedBefore)) {
          hasConflict = true;
          conflicts.push({
            targetIdentity: record.targetIdentity,
            field,
            expectedBefore,
            current,
          });
        }
      }
      for (const variantChange of Array.isArray(record?.variantFieldChanges) ? record.variantFieldChanges : []) {
        const node = nodeMap.get(String(variantChange?.variantId));
        if (!node || node.__typename !== "ProductVariant") continue;
        for (const fieldChange of Array.isArray(variantChange?.changes) ? variantChange.changes : [variantChange]) {
          const field = String(fieldChange?.field || "");
          const expectedBefore = fieldChange?.oldValue ?? fieldChange?.newValue;
          const mapField = field === "inventory" ? "inventoryQuantity" : field;
          const current = node[mapField] ?? null;
          if (expectedBefore === undefined || expectedBefore === null || String(current) === String(expectedBefore)) {
            continue;
          }
          hasConflict = true;
          conflicts.push({
            targetIdentity: record.targetIdentity,
            field,
            expectedBefore,
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
      const snapshotMissing = !snapshotBeforeValues || Object.keys(snapshotBeforeValues).length === 0;

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
        return {
          ...record,
          status: "FAILED",
          failureCode: "UNDO_BEFORE_VALUES_REQUIRED",
          failureMessage: "Undo before-values were missing for this target",
          productFieldChanges: [],
          variantFieldChanges: [],
        };
      }

      if (snapshotMissing) {
        return {
          ...record,
          status: "FAILED",
          failureCode: "UNDO_SNAPSHOT_BEFORE_VALUES_REQUIRED",
          failureMessage: "Undo snapshot before-values were missing for this target",
          productFieldChanges: [],
          variantFieldChanges: [],
        };
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
