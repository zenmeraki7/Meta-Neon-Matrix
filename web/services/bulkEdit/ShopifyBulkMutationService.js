import crypto from "crypto";
import {
  bulkOperationMutation,
  getProductSetMutation,
  PRODUCT_SET_MODE,
  stagesUploadMutation,
} from "../../helpers/productBulkOperationHelpers/mutationTemplates.js";
import {
  OPTION_NAME_FIELDS,
  isVariantLevelField,
} from "./bulkEditRuleUtils.js";
import {
  normalizeEditHistoryExecutionState,
} from "../../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../operationLifecycleStateMachine.js";

const CURRENT_BULK_OPERATION_QUERY = `
  query CurrentBulkOperation {
    currentBulkOperation {
      id
      status
      type
      createdAt
      objectCount
      fileSize
      url
      partialDataUrl
    }
  }
`;

const ACTIVE_BULK_STATUSES = new Set([
  "CREATED",
  "RUNNING",
  "CANCELING",
]);

function determineMutationMode(fields = []) {
  const normalizedFields = Array.isArray(fields) ? fields.filter(Boolean) : [];

  const includesDelete = normalizedFields.includes("deleteProducts");
  const includesVariant = normalizedFields.some((field) =>
    isVariantLevelField(field),
  );
  const includesProduct = normalizedFields.some(
    (field) => !isVariantLevelField(field) && field !== "deleteProducts",
  );
  const includesOptionNames = normalizedFields.some((field) =>
    OPTION_NAME_FIELDS.has(field),
  );

  if (includesDelete) {
    return PRODUCT_SET_MODE.PRODUCT_DELETE;
  }

  if (includesOptionNames || (includesProduct && includesVariant)) {
    return PRODUCT_SET_MODE.BOTH;
  }

  if (includesVariant) {
    return PRODUCT_SET_MODE.VARIANT_ONLY;
  }

  return PRODUCT_SET_MODE.PRODUCT_ONLY;
}

function assertSubmissionInput({
  historyId,
  formattedProducts,
  fields,
}) {
  if (!historyId) {
    throw new Error("historyId is required");
  }

  if (!formattedProducts || !String(formattedProducts).trim()) {
    throw new Error("No formatted mutation rows were provided.");
  }

  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error("Edited fields are required for mutation planning.");
  }
}

function buildOperationName({ historyId, batchId }) {
  return `bulkEdit_${historyId}_${batchId || Date.now()}`;
}

function normalizeBulkOperationResponse(result) {
  const bulkOperation =
    result?.bulkOperation ||
    result?.body?.data?.bulkOperationRunMutation?.bulkOperation ||
    null;

  return {
    id: bulkOperation?.id || null,
    status: bulkOperation?.status || null,
    type: bulkOperation?.type || null,
    createdAt: bulkOperation?.createdAt || null,
  };
}

function mergeBatch(existingBatch, patch) {
  return {
    ...(existingBatch && typeof existingBatch === "object" ? existingBatch : {}),
    ...patch,
  };
}

function buildSubmissionIntent({
  executionId,
  batchId,
  lastProductId,
  hasMore,
  nextRetryCursorIndex,
  operationName,
}) {
  return {
    status: "PENDING",
    submissionStage: "PENDING_SUBMIT",
    executionId: executionId || null,
    batchId: batchId || null,
    lastProductId: lastProductId ?? null,
    hasMore: Boolean(hasMore),
    nextRetryCursorIndex: Number.isInteger(nextRetryCursorIndex) ? nextRetryCursorIndex : null,
    operationName: operationName || null,
    bulkOperationId: null,
    stagedUploadPath: null,
    stagedUploadPathHash: null,
    createdAt: new Date().toISOString(),
  };
}

function hashValue(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function countJsonlLines(payload) {
  const text = String(payload || "");
  if (!text.trim()) return 0;
  return text.split("\n").filter((line) => String(line || "").trim().length > 0).length;
}

export class ShopifyBulkMutationService {
  constructor(session, client, deps = {}) {
    this.session = session;
    this.client = client;
    this.db = deps.db || null;
    this.uploadToShopifyStagedTarget = deps.uploadToShopifyStagedTarget || null;
    this.upsertOperationStageProgress = deps.upsertOperationStageProgress || null;
    this.cacheSet = deps.cacheSet || null;
  }

  async getDb() {
    if (this.db) return this.db;
    const { prisma } = await import("../../config/database.js");
    this.db = prisma;
    return this.db;
  }

  async resolveUploadToShopifyStagedTarget() {
    if (this.uploadToShopifyStagedTarget) return this.uploadToShopifyStagedTarget;
    const mod = await import("../../utils/productBulkEditUtils.js");
    this.uploadToShopifyStagedTarget = mod.uploadToShopifyStagedTarget;
    return this.uploadToShopifyStagedTarget;
  }

  async resolveStageProgressUpsert() {
    if (this.upsertOperationStageProgress) return this.upsertOperationStageProgress;
    const mod = await import("../operationStageProgressService.js");
    this.upsertOperationStageProgress = mod.upsertOperationStageProgress;
    return this.upsertOperationStageProgress;
  }

  async getCurrentBulkOperation() {
    const response = await this.client.query({
      data: {
        query: CURRENT_BULK_OPERATION_QUERY,
      },
    });

    return response?.body?.data?.currentBulkOperation || null;
  }

  async assertNoActiveMutationOperation() {
    const currentBulkOperation = await this.getCurrentBulkOperation();

    if (
      currentBulkOperation?.type === "MUTATION" &&
      ACTIVE_BULK_STATUSES.has(String(currentBulkOperation.status || ""))
    ) {
      return {
        available: false,
        currentBulkOperation,
      };
    }

    return {
      available: true,
      currentBulkOperation,
    };
  }

  async createStagedUploadTarget({ operationName }) {
    const stagedRes = await this.client.query({
      data: {
        query: stagesUploadMutation,
        variables: {
          input: [
            {
              filename: operationName,
              mimeType: "text/jsonl",
              resource: "BULK_MUTATION_VARIABLES",
              httpMethod: "POST",
            },
          ],
        },
      },
    });

    const userErrors =
      stagedRes?.body?.data?.stagedUploadsCreate?.userErrors || [];

    if (userErrors.length) {
      throw new Error(
        `Shopify staged upload returned errors: ${JSON.stringify(userErrors)}`,
      );
    }

    const target =
      stagedRes?.body?.data?.stagedUploadsCreate?.stagedTargets?.[0];

    if (!target) {
      throw new Error("Failed to get staged upload target from Shopify.");
    }

    return target;
  }

  async submitProductSetBulkMutation({
    historyId,
    executionId = null,
    submitFence = null,
    formattedProducts,
    fields = [],
    batchId,
    batchTargetCount = 0,
    lastProductId = null,
    hasMore = false,
    nextRetryCursorIndex = null,
  }) {
    assertSubmissionInput({
      historyId,
      formattedProducts,
      fields,
    });
    const db = await this.getDb();
    const stageProgressUpsert = await this.resolveStageProgressUpsert();

    const history = await db.editHistory.findFirst({
      where: {
        id: historyId,
        shop: this.session.shop,
      },
      select: {
        id: true,
        shop: true,
        batch: true,
        executionIdentity: true,
        cancelRequestedAt: true,
      },
    });

    if (!history) {
      throw new Error("Edit history not found");
    }

    if (
      executionId &&
      history.executionIdentity &&
      executionId !== history.executionIdentity
    ) {
      throw new Error("STALE_EXECUTION_JOB");
    }
    if (submitFence?.leaseOwnerId || submitFence?.fencingToken) {
      const batchLeaseOwner = String(history.batch?.executeLeaseOwnerId || "");
      const batchFenceToken = Number(history.batch?.executeLeaseFencingToken || 0);
      if (
        !batchLeaseOwner
        || batchLeaseOwner !== String(submitFence.leaseOwnerId || "")
        || batchFenceToken !== Number(submitFence.fencingToken || 0)
      ) {
        throw new Error("SUBMIT_FENCE_MISMATCH");
      }
    }

    if (history.cancelRequestedAt) {
      throw new Error("OPERATION_CANCEL_REQUESTED");
    }

    const alreadySubmitted =
      history.batch?.shopifyBulkOperation?.id ||
      history.batch?.shopifyBulkOperationId;

    if (alreadySubmitted) {
      throw new Error("SHOPIFY_BULK_OPERATION_ALREADY_SUBMITTED");
    }
    await stageProgressUpsert({
      shop: this.session.shop,
      operationType: "BULK_EDIT",
      operationId: historyId,
      executionId: history.executionIdentity || executionId || null,
      stageKey: "SHOPIFY_SUBMISSION",
      stageStatus: "PREPARED_JSONL",
      detail: {
        batchId: batchId || null,
        jsonlHash: hashValue(formattedProducts),
        jsonlRowCount: countJsonlLines(formattedProducts),
      },
    });
    await stageProgressUpsert({
      shop: this.session.shop,
      operationType: "BULK_EDIT",
      operationId: historyId,
      executionId: history.executionIdentity || executionId || null,
      stageKey: "SHOPIFY_SUBMISSION",
      stageStatus: "PENDING_SUBMIT",
      detail: {
        batchId: batchId || null,
        submitFence: submitFence || null,
      },
    });

    const existingSubmission = await db.bulkSubmission.findFirst({
      where: {
        shop: this.session.shop,
        editHistoryId: historyId,
        executionIdentity: history.executionIdentity || null,
        ...(batchId ? { batchId } : {}),
      },
      orderBy: { submittedAt: "desc" },
      select: {
        shopifyBulkOperationId: true,
        shopifyStatus: true,
        submittedAt: true,
        operationName: true,
        mutationMode: true,
        stagedUploadPath: true,
        batchId: true,
      },
    });
    if (existingSubmission?.shopifyBulkOperationId) {
      const submittedAtIso = new Date(existingSubmission.submittedAt).toISOString();
      await db.editHistory.updateMany({
        where: {
          id: historyId,
          shop: this.session.shop,
          batch: {
            path: ["shopifyBulkOperation", "id"],
            equals: null,
          },
        },
        data: {
          executionState: OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING,
          ),
          batch: mergeBatch(history.batch, {
            shopifySubmissionIntent: null,
            shopifyBulkOperation: {
              id: existingSubmission.shopifyBulkOperationId,
              status: existingSubmission.shopifyStatus || null,
              submittedAt: submittedAtIso,
              operationName: existingSubmission.operationName || null,
              mutationMode: existingSubmission.mutationMode || null,
              batchId: existingSubmission.batchId || batchId || null,
              batchTargetCount,
              lastProductId,
              hasMore,
              nextRetryCursorIndex,
              stagedUploadPath: existingSubmission.stagedUploadPath || null,
            },
            shopifyBulkOperationId: existingSubmission.shopifyBulkOperationId,
            submittedBatchId: existingSubmission.batchId || batchId || null,
            lastSubmittedAt: submittedAtIso,
            lastProductId,
            hasMore,
            nextRetryCursorIndex,
          }),
        },
      });
      return {
        submitted: true,
        reconciled: true,
        historyId,
        bulkOperationId: existingSubmission.shopifyBulkOperationId,
        batchId: existingSubmission.batchId || batchId || null,
        batchTargetCount,
        lastProductId,
        hasMore,
        nextRetryCursorIndex,
      };
    }

    const pendingIntent = history.batch?.shopifySubmissionIntent;
    if (
      pendingIntent
      && String(pendingIntent.status || "").toUpperCase() === "PENDING"
      && (!executionId || !pendingIntent.executionId || pendingIntent.executionId === executionId)
    ) {
      const intentBulkOperationId = String(pendingIntent.bulkOperationId || "").trim();
      const intentOperationName = String(pendingIntent.operationName || "").trim() || buildOperationName({ historyId, batchId });
      if (intentBulkOperationId) {
        await db.bulkSubmission.upsert({
          where: {
            shop_shopifyBulkOperationId: {
              shop: this.session.shop,
              shopifyBulkOperationId: intentBulkOperationId,
            },
          },
          create: {
            shop: this.session.shop,
            editHistoryId: historyId,
            executionIdentity: history.executionIdentity || executionId || null,
            batchId: batchId || null,
            operationName: intentOperationName,
            mutationMode: "UNKNOWN",
            stagedUploadPath: pendingIntent.stagedUploadPath || null,
            shopifyBulkOperationId: intentBulkOperationId,
            shopifyStatus: null,
            submittedAt: new Date(),
          },
          update: {
            editHistoryId: historyId,
            executionIdentity: history.executionIdentity || executionId || null,
            batchId: batchId || null,
            operationName: intentOperationName,
            stagedUploadPath: pendingIntent.stagedUploadPath || null,
          },
        });
        await db.editHistory.update({
          where: { id: historyId },
          data: {
            executionState: OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING,
            executionStateNormalized: normalizeEditHistoryExecutionState(
              OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING,
            ),
            batch: mergeBatch(history.batch, {
              shopifySubmissionIntent: null,
              shopifyBulkOperation: {
                id: intentBulkOperationId,
                status: null,
                submittedAt: new Date().toISOString(),
                operationName: intentOperationName,
                mutationMode: "UNKNOWN",
                batchId: batchId || null,
                batchTargetCount,
                lastProductId,
                hasMore,
                nextRetryCursorIndex,
                stagedUploadPath: pendingIntent.stagedUploadPath || null,
              },
              shopifyBulkOperationId: intentBulkOperationId,
              submittedBatchId: batchId || null,
              lastSubmittedAt: new Date().toISOString(),
            }),
          },
        });
        return {
          submitted: true,
          reconciled: true,
          pendingIntent: true,
          historyId,
          bulkOperationId: intentBulkOperationId,
        };
      }
      const slotFromPending = await this.assertNoActiveMutationOperation();
      if (!slotFromPending.available) {
        await db.editHistory.update({
          where: { id: historyId },
          data: {
            executionState: OPERATION_LIFECYCLE_STATES.WAITING_FOR_SHOPIFY_SLOT,
            executionStateNormalized: normalizeEditHistoryExecutionState(
              OPERATION_LIFECYCLE_STATES.WAITING_FOR_SHOPIFY_SLOT,
            ),
            batch: mergeBatch(history.batch, {
              waitingForShopifySlot: true,
              currentShopifyBulkOperation: slotFromPending.currentBulkOperation,
              waitingForShopifySlotAt: new Date().toISOString(),
            }),
          },
        });
        return {
          submitted: false,
          waitingForShopifySlot: true,
          currentBulkOperation: slotFromPending.currentBulkOperation,
          pendingIntent: true,
        };
      }
      throw new Error("PENDING_SUBMIT_INTENT_REQUIRES_RECONCILIATION");
    }

    const slot = await this.assertNoActiveMutationOperation();

    if (!slot.available) {
      await this.db.editHistory.update({
        where: { id: historyId },
        data: {
          executionState: OPERATION_LIFECYCLE_STATES.WAITING_FOR_SHOPIFY_SLOT,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            OPERATION_LIFECYCLE_STATES.WAITING_FOR_SHOPIFY_SLOT,
          ),
          batch: mergeBatch(history.batch, {
            waitingForShopifySlot: true,
            currentShopifyBulkOperation: slot.currentBulkOperation,
            waitingForShopifySlotAt: new Date().toISOString(),
          }),
        },
      });
      await stageProgressUpsert({
        shop: this.session.shop,
        operationType: "BULK_EDIT",
        operationId: historyId,
        executionId: history.executionIdentity || null,
        stageKey: "SHOPIFY_SUBMISSION",
        stageStatus: "WAITING_SLOT",
        detail: {
          currentBulkOperation: slot.currentBulkOperation || null,
        },
      });

      return {
        submitted: false,
        waitingForShopifySlot: true,
        currentBulkOperation: slot.currentBulkOperation,
      };
    }

    const operationName = buildOperationName({ historyId, batchId });
    const mode = determineMutationMode(fields);
    const submissionIntent = buildSubmissionIntent({
      executionId: history.executionIdentity || executionId || null,
      batchId,
      lastProductId,
      hasMore,
      nextRetryCursorIndex,
      operationName,
    });
    await db.editHistory.update({
      where: { id: historyId },
      data: {
        batch: mergeBatch(history.batch, {
          shopifySubmissionIntent: submissionIntent,
        }),
      },
    });
    await stageProgressUpsert({
      shop: this.session.shop,
      operationType: "BULK_EDIT",
      operationId: historyId,
      executionId: history.executionIdentity || executionId || null,
      stageKey: "SHOPIFY_SUBMISSION",
      stageStatus: "PENDING_SUBMIT",
      detail: {
        batchId: batchId || null,
        operationName,
        submitFence: submitFence || null,
      },
    });

    const stagedTarget = await this.createStagedUploadTarget({
      operationName,
    });
    await db.editHistory.update({
      where: { id: historyId },
      data: {
        batch: mergeBatch(history.batch, {
          shopifySubmissionIntent: {
            ...submissionIntent,
            submissionStage: "STAGED_UPLOAD_CREATED",
          },
        }),
      },
    });
    await stageProgressUpsert({
      shop: this.session.shop,
      operationType: "BULK_EDIT",
      operationId: historyId,
      executionId: history.executionIdentity || executionId || null,
      stageKey: "SHOPIFY_SUBMISSION",
      stageStatus: "STAGED_UPLOAD_CREATED",
      detail: {
        operationName,
        stagedTarget,
      },
    });

    const uploadToStagedTarget = await this.resolveUploadToShopifyStagedTarget();
    const stagedUploadPath = await uploadToStagedTarget(
      stagedTarget,
      formattedProducts,
    );
    await db.editHistory.update({
      where: { id: historyId },
      data: {
        batch: mergeBatch(history.batch, {
          shopifySubmissionIntent: {
            ...submissionIntent,
            submissionStage: "UPLOADED",
            stagedUploadPath,
            stagedUploadPathHash: hashValue(stagedUploadPath),
          },
        }),
      },
    });
    await stageProgressUpsert({
      shop: this.session.shop,
      operationType: "BULK_EDIT",
      operationId: historyId,
      executionId: history.executionIdentity || executionId || null,
      stageKey: "SHOPIFY_SUBMISSION",
      stageStatus: "UPLOADED",
      detail: {
        operationName,
        stagedUploadPath,
        stagedUploadPathHash: hashValue(stagedUploadPath),
      },
    });

    const bulkRes = await this.client.query({
      data: {
        query: bulkOperationMutation,
        variables: {
          mutation: getProductSetMutation(mode),
          stagedUploadPath,
        },
      },
    });

    const bulkErrors =
      bulkRes?.body?.data?.bulkOperationRunMutation?.userErrors;

    if (bulkErrors?.length) {
      throw new Error(
        `Bulk operation returned errors: ${JSON.stringify(bulkErrors)}`,
      );
    }

    const result = bulkRes?.body?.data?.bulkOperationRunMutation;
    const bulkOperation = normalizeBulkOperationResponse(result);

    if (!bulkOperation.id) {
      throw new Error("Shopify did not return a bulk operation id.");
    }
    await db.editHistory.update({
      where: { id: historyId },
      data: {
        batch: mergeBatch(history.batch, {
          shopifySubmissionIntent: {
            ...submissionIntent,
            submissionStage: "SUBMIT_RESPONSE_RECEIVED",
            stagedUploadPath,
            stagedUploadPathHash: hashValue(stagedUploadPath),
            bulkOperationId: bulkOperation.id,
          },
        }),
      },
    });
    await stageProgressUpsert({
      shop: this.session.shop,
      operationType: "BULK_EDIT",
      operationId: historyId,
      executionId: history.executionIdentity || executionId || null,
      stageKey: "SHOPIFY_SUBMISSION",
      stageStatus: "SUBMIT_RESPONSE_RECEIVED",
      detail: {
        operationName,
        stagedUploadPath,
        stagedUploadPathHash: hashValue(stagedUploadPath),
        shopifyBulkOperationId: bulkOperation.id,
        shopifyStatus: bulkOperation.status || null,
        shopifyType: bulkOperation.type || null,
      },
    });

    const submittedAt = new Date();

    const finalizeResult = await db.$transaction(async (tx) => {
      await tx.bulkSubmission.create({
        data: {
          shop: this.session.shop,
          editHistoryId: historyId,
          executionIdentity: history.executionIdentity || null,
          batchId: batchId || null,
          operationName,
          mutationMode: String(mode),
          stagedUploadPath,
          shopifyBulkOperationId: bulkOperation.id,
          shopifyStatus: bulkOperation.status || null,
          submittedAt,
        },
      });

      const updated = await tx.editHistory.updateMany({
        where: {
          id: historyId,
          shop: this.session.shop,
          executionIdentity: history.executionIdentity || null,
          batch: {
            path: ["shopifyBulkOperation", "id"],
            equals: null,
          },
        },
        data: {
          executionState: OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING,
          ),
          batch: mergeBatch(history.batch, {
            shopifySubmissionIntent: null,
            waitingForShopifySlot: false,
            shopifyBulkOperation: {
              id: bulkOperation.id,
              status: bulkOperation.status,
              type: bulkOperation.type,
              createdAt: bulkOperation.createdAt,
              submittedAt: submittedAt.toISOString(),
              operationName,
              mutationMode: mode,
              batchId,
              batchTargetCount,
              lastProductId,
              hasMore,
              nextRetryCursorIndex,
              stagedUploadPath,
            },
            shopifyBulkOperationId: bulkOperation.id,
            submittedBatchId: batchId,
            lastProductId,
            hasMore,
            nextRetryCursorIndex,
            lastSubmittedAt: submittedAt.toISOString(),
          }),
        },
      });
      return updated;
    });
    if (Number(finalizeResult?.count || 0) !== 1) {
      throw new Error("SHOPIFY_SUBMISSION_FINALIZE_CONFLICT");
    }

    if (this.cacheSet) {
      await this.cacheSet(`${this.session.shop}:PRODUCT_UPDATE`, {
        running: true,
        historyId,
        bulkOperationId: bulkOperation.id,
      });
    } else {
      const { default: CacheService } = await import("../../utils/cacheService.js");
      await CacheService.set(`${this.session.shop}:PRODUCT_UPDATE`, {
        running: true,
        historyId,
        bulkOperationId: bulkOperation.id,
      });
    }
    await stageProgressUpsert({
      shop: this.session.shop,
      operationType: "BULK_EDIT",
      operationId: historyId,
      executionId: history.executionIdentity || null,
      stageKey: "SHOPIFY_SUBMISSION",
      stageStatus: "SUBMITTED",
      detail: {
        bulkOperationId: bulkOperation.id,
        status: bulkOperation.status,
        batchId: batchId || null,
      },
      completed: true,
    });

    return {
      submitted: true,
      historyId,
      bulkOperationId: bulkOperation.id,
      bulkOperation,
      operationName,
      mutationMode: mode,
      batchId,
      batchTargetCount,
      lastProductId,
      hasMore,
      nextRetryCursorIndex,
    };
  }

  async submitBulkMutation(args) {
    return this.submitProductSetBulkMutation(args);
  }
}

