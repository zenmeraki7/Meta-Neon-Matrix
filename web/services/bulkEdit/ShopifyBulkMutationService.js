import CacheService from "../../utils/cacheService.js";
import { prisma } from "../../config/database.js";
import { uploadToShopifyStagedTarget } from "../../utils/productBulkEditUtils.js";
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
import { upsertOperationStageProgress } from "../operationStageProgressService.js";

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

export class ShopifyBulkMutationService {
  constructor(session, client) {
    this.session = session;
    this.client = client;
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

    const history = await prisma.editHistory.findFirst({
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

    if (history.cancelRequestedAt) {
      throw new Error("OPERATION_CANCEL_REQUESTED");
    }

    const alreadySubmitted =
      history.batch?.shopifyBulkOperation?.id ||
      history.batch?.shopifyBulkOperationId;

    if (alreadySubmitted) {
      throw new Error("SHOPIFY_BULK_OPERATION_ALREADY_SUBMITTED");
    }

    const slot = await this.assertNoActiveMutationOperation();

    if (!slot.available) {
      await prisma.editHistory.update({
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
      await upsertOperationStageProgress({
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

    const stagedTarget = await this.createStagedUploadTarget({
      operationName,
    });

    const stagedUploadPath = await uploadToShopifyStagedTarget(
      stagedTarget,
      formattedProducts,
    );

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

    const submittedAt = new Date();

    await prisma.bulkSubmission.create({
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

    await prisma.editHistory.update({
      where: { id: historyId },
      data: {
        executionState: OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING,
        executionStateNormalized: normalizeEditHistoryExecutionState(
          OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING,
        ),
        batch: mergeBatch(history.batch, {
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

    await CacheService.set(`${this.session.shop}:PRODUCT_UPDATE`, {
      running: true,
      historyId,
      bulkOperationId: bulkOperation.id,
    });
    await upsertOperationStageProgress({
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
