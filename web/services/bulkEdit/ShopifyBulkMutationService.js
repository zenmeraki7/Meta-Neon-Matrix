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
import { db as defaultDb } from "../../repositories/repositoryDb.js";
import { uploadToShopifyStagedTarget as defaultUploadToShopifyStagedTarget } from "../../utils/productBulkEditUtils.js";
import { upsertOperationStageProgress as defaultUpsertOperationStageProgress } from "../operationStageProgressService.js";
import CacheService from "../../utils/cacheService.js";

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

const CAS_MUTABLE_EXECUTION_STATES = [
  OPERATION_LIFECYCLE_STATES.QUEUED,
  OPERATION_LIFECYCLE_STATES.WAITING_FOR_SHOPIFY_SLOT,
  OPERATION_LIFECYCLE_STATES.EXECUTING,
  OPERATION_LIFECYCLE_STATES.SHOPIFY_BULK_SUBMITTED,
  OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING,
  OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
  OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
];

const ADAPTIVE_BATCH_SIZE_MIN = clampBatchSize(
  process.env.BULK_EDIT_DYNAMIC_BATCH_SIZE_MIN || "25",
  1,
  500,
);
const ADAPTIVE_BATCH_SIZE_MAX = clampBatchSize(
  process.env.BULK_EDIT_DYNAMIC_BATCH_SIZE_MAX || "250",
  ADAPTIVE_BATCH_SIZE_MIN,
  1_000,
);

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
  return `bulkEdit_${historyId}_${batchId || "unbatched"}`;
}

function normalizeBulkOperationResponse(result) {
  const bulkOperation = result?.bulkOperation || null;

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
  return text.split(/\r?\n/).filter((line) => String(line || "").trim().length > 0).length;
}

function isNonEmptyObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length > 0;
}

async function assertReversibleOperationLog({
  db,
  shop,
  historyId,
  batchId,
  expectedCount,
}) {
  if (!batchId) throw new Error("SHOPIFY_WRITE_REQUIRES_REVERSIBLE_LOG_BATCH_ID");
  const records = await db.changeRecord.findMany({
    where: {
      shop,
      editHistoryId: historyId,
      batchId,
    },
    select: {
      targetIdentity: true,
      beforeValues: true,
      afterValues: true,
      status: true,
    },
  });
  const validRecords = records.filter((record) =>
    String(record?.targetIdentity || "").trim()
    && isNonEmptyObject(record?.beforeValues)
    && isNonEmptyObject(record?.afterValues)
    && ["pending", "failed"].includes(String(record?.status || "").toLowerCase()));
  if (
    validRecords.length !== records.length
    || validRecords.length !== Number(expectedCount || 0)
  ) {
    throw new Error(
      `SHOPIFY_WRITE_BLOCKED_REVERSIBLE_LOG_INCOMPLETE:${validRecords.length}:${expectedCount}`,
    );
  }
}

function clampBatchSize(value, min, max) {
  const num = Number.parseInt(String(value || 0), 10);
  if (!Number.isFinite(num)) return min;
  return Math.min(max, Math.max(min, num));
}

function deriveAdaptiveBatchSize({
  throttleStatus,
  actualQueryCost,
  batchTargetCount,
  currentBatchSize,
}) {
  const minBatchSize = ADAPTIVE_BATCH_SIZE_MIN;
  const maxBatchSize = ADAPTIVE_BATCH_SIZE_MAX;

  const availableBudget = Number(throttleStatus?.currentlyAvailable || 0);
  const restoreRate = Number(throttleStatus?.restoreRate || 0);
  const observedCost = Number(actualQueryCost || 0);
  const observedItems = Number(batchTargetCount || 0);

  if (!(availableBudget > 0) || !(observedCost > 0) || !(observedItems > 0)) {
    return {
      nextBatchSize: clampBatchSize(currentBatchSize || maxBatchSize, minBatchSize, maxBatchSize),
      costPerItem: null,
      minBatchSize,
      maxBatchSize,
      availableBudget,
      restoreRate,
      reason: "INSUFFICIENT_COST_SIGNAL",
    };
  }

  const costPerItem = observedCost / observedItems;
  if (!(costPerItem > 0)) {
    return {
      nextBatchSize: clampBatchSize(currentBatchSize || maxBatchSize, minBatchSize, maxBatchSize),
      costPerItem: null,
      minBatchSize,
      maxBatchSize,
      availableBudget,
      restoreRate,
      reason: "INVALID_COST_PER_ITEM",
    };
  }

  const targetBudget = Math.max(1, availableBudget * 0.8);
  const nextBatchSize = clampBatchSize(
    Math.floor(targetBudget / costPerItem),
    minBatchSize,
    maxBatchSize,
  );

  return {
    nextBatchSize,
    costPerItem,
    minBatchSize,
    maxBatchSize,
    availableBudget,
    restoreRate,
    reason: "ADAPTIVE_COST_FEEDBACK",
  };
}

export class ShopifyBulkMutationService {
  constructor(session, client, deps = {}) {
    this.session = session;
    this.client = client;
    this.db = deps.db || defaultDb;
    this.uploadToShopifyStagedTarget =
      deps.uploadToShopifyStagedTarget || defaultUploadToShopifyStagedTarget;
    this.upsertOperationStageProgress =
      deps.upsertOperationStageProgress || defaultUpsertOperationStageProgress;
    this.cacheSet = deps.cacheSet || ((key, value) => CacheService.set(key, value));
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
    const db = this.db;
    const stageProgressUpsert = this.upsertOperationStageProgress;

    const history = await db.editHistory.findFirst({
      where: {
        id: historyId,
        shop: this.session.shop,
      },
      select: {
        id: true,
        shop: true,
        batch: true,
        undo: true,
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
    if (history.undo?.allowed === false) {
      throw new Error("SHOPIFY_WRITE_BLOCKED_OPERATION_NOT_REVERSIBLE");
    }
    await assertReversibleOperationLog({
      db,
      shop: this.session.shop,
      historyId,
      batchId,
      expectedCount: batchTargetCount,
    });
    let batchState = history.batch && typeof history.batch === "object" ? history.batch : {};
    const mergeCurrentBatch = (patch) => mergeBatch(batchState, patch);
    const rememberBatch = (nextBatch) => {
      batchState = nextBatch && typeof nextBatch === "object" ? nextBatch : batchState;
      return batchState;
    };
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
          executionState: { in: CAS_MUTABLE_EXECUTION_STATES },
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
          batch: rememberBatch(mergeCurrentBatch({
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
          })),
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
    let replayUploadIntent = null;
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
        const movedRunningFromIntent = await db.editHistory.updateMany({
          where: {
            id: historyId,
            shop: this.session.shop,
            executionState: { in: CAS_MUTABLE_EXECUTION_STATES },
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
            batch: rememberBatch(mergeCurrentBatch({
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
            })),
          },
        });
        if (movedRunningFromIntent.count !== 1) {
          throw new Error("SHOPIFY_SUBMISSION_RECONCILE_TRANSITION_REJECTED");
        }
        return {
          submitted: true,
          reconciled: true,
          pendingIntent: true,
          historyId,
          bulkOperationId: intentBulkOperationId,
        };
      }
      if (
        String(pendingIntent.submissionStage || "").toUpperCase() === "UPLOADED"
        && String(pendingIntent.stagedUploadPath || "").trim()
      ) {
        replayUploadIntent = pendingIntent;
      } else if (
        String(pendingIntent.submissionStage || "").toUpperCase() === "SUBMITTING"
      ) {
        throw new Error("PENDING_SUBMIT_INTENT_REQUIRES_RECONCILIATION");
      }
    }

    const slot = await this.assertNoActiveMutationOperation();

    if (!slot.available) {
      const movedWaiting = await db.editHistory.updateMany({
        where: {
          id: historyId,
          shop: this.session.shop,
          executionState: { in: CAS_MUTABLE_EXECUTION_STATES },
        },
        data: {
          executionState: OPERATION_LIFECYCLE_STATES.WAITING_FOR_SHOPIFY_SLOT,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            OPERATION_LIFECYCLE_STATES.WAITING_FOR_SHOPIFY_SLOT,
          ),
          batch: rememberBatch(mergeCurrentBatch({
            waitingForShopifySlot: true,
            currentShopifyBulkOperation: slot.currentBulkOperation,
            waitingForShopifySlotAt: new Date().toISOString(),
          })),
        },
      });
      if (movedWaiting.count !== 1) {
        throw new Error("SHOPIFY_SUBMISSION_WAIT_SLOT_TRANSITION_REJECTED");
      }
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

    const operationName = String(replayUploadIntent?.operationName || "").trim()
      || buildOperationName({ historyId, batchId });
    const mode = determineMutationMode(fields);
    const submissionIntent = replayUploadIntent
      ? {
        ...buildSubmissionIntent({
          executionId: history.executionIdentity || executionId || null,
          batchId,
          lastProductId,
          hasMore,
          nextRetryCursorIndex,
          operationName,
        }),
        ...replayUploadIntent,
        submissionStage: "UPLOADED",
      }
      : buildSubmissionIntent({
        executionId: history.executionIdentity || executionId || null,
        batchId,
        lastProductId,
        hasMore,
        nextRetryCursorIndex,
        operationName,
      });
    if (!replayUploadIntent) {
      const intentSet = await db.editHistory.updateMany({
        where: {
          id: historyId,
          shop: this.session.shop,
          executionState: { in: CAS_MUTABLE_EXECUTION_STATES },
          batch: {
            path: ["shopifyBulkOperation", "id"],
            equals: null,
          },
        },
        data: {
          batch: rememberBatch(mergeCurrentBatch({
            shopifySubmissionIntent: submissionIntent,
          })),
        },
      });
      if (intentSet.count !== 1) {
        throw new Error("SHOPIFY_SUBMISSION_INTENT_SET_REJECTED");
      }
    }
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
        jsonlHash: hashValue(formattedProducts),
        jsonlRowCount: countJsonlLines(formattedProducts),
      },
    });

    let stagedUploadPath = String(replayUploadIntent?.stagedUploadPath || "").trim();
    if (stagedUploadPath) {
      await stageProgressUpsert({
        shop: this.session.shop,
        operationType: "BULK_EDIT",
        operationId: historyId,
        executionId: history.executionIdentity || executionId || null,
        stageKey: "SHOPIFY_SUBMISSION",
        stageStatus: "REPLAY_UPLOADED",
        detail: {
          operationName,
          stagedUploadPath,
          stagedUploadPathHash: hashValue(stagedUploadPath),
        },
      });
    } else {
      const stagedTarget = await this.createStagedUploadTarget({
        operationName,
      });
      const stagedTargetSet = await db.editHistory.updateMany({
        where: {
          id: historyId,
          shop: this.session.shop,
          executionState: { in: CAS_MUTABLE_EXECUTION_STATES },
        },
        data: {
          batch: rememberBatch(mergeCurrentBatch({
            shopifySubmissionIntent: {
              ...submissionIntent,
              submissionStage: "STAGED_UPLOAD_CREATED",
            },
          })),
        },
      });
      if (stagedTargetSet.count !== 1) {
        throw new Error("SHOPIFY_SUBMISSION_STAGE_UPLOAD_TRANSITION_REJECTED");
      }
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

      stagedUploadPath = await this.uploadToShopifyStagedTarget(
        stagedTarget,
        formattedProducts,
      );
      const stagedUploadPathHash = hashValue(stagedUploadPath);
      const uploadedSet = await db.editHistory.updateMany({
        where: {
          id: historyId,
          shop: this.session.shop,
          executionState: { in: CAS_MUTABLE_EXECUTION_STATES },
        },
        data: {
          batch: rememberBatch(mergeCurrentBatch({
            shopifySubmissionIntent: {
              ...submissionIntent,
              submissionStage: "UPLOADED",
              stagedUploadPath,
              stagedUploadPathHash,
            },
          })),
        },
      });
      if (uploadedSet.count !== 1) {
        throw new Error("SHOPIFY_SUBMISSION_UPLOAD_TRANSITION_REJECTED");
      }
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
          stagedUploadPathHash,
        },
      });
    }

    const submittingSet = await db.editHistory.updateMany({
      where: {
        id: historyId,
        shop: this.session.shop,
        executionState: { in: CAS_MUTABLE_EXECUTION_STATES },
      },
      data: {
        batch: rememberBatch(mergeCurrentBatch({
          shopifySubmissionIntent: {
            ...submissionIntent,
            submissionStage: "SUBMITTING",
            stagedUploadPath,
            stagedUploadPathHash: hashValue(stagedUploadPath),
          },
        })),
      },
    });
    if (submittingSet.count !== 1) {
      throw new Error("SHOPIFY_SUBMISSION_SUBMITTING_TRANSITION_REJECTED");
    }

    await db.changeRecord.updateMany({
      where: {
        shop: this.session.shop,
        editHistoryId: historyId,
        batchId,
        status: { in: ["pending", "PENDING", "failed", "FAILED"] },
      },
      data: {
        attemptCount: { increment: 1 },
        retryable: true,
        writingStartedAt: new Date(),
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

    const result = bulkRes?.body?.data?.bulkOperationRunMutation;
    const bulkOperation = normalizeBulkOperationResponse(result);
    const bulkErrors = Array.isArray(result?.userErrors) ? result.userErrors : [];
    if (bulkErrors.length && !bulkOperation.id) {
      throw new Error(
        `Bulk operation returned errors: ${JSON.stringify(bulkErrors)}`,
      );
    }
    const stagedUploadPathHash = hashValue(stagedUploadPath);
    const throttleStatus = bulkRes?.body?.extensions?.cost?.throttleStatus || null;
    const actualQueryCost = Number(
      bulkRes?.body?.extensions?.cost?.actualQueryCost || 0,
    );
    const adaptiveSizing = deriveAdaptiveBatchSize({
      throttleStatus,
      actualQueryCost,
      batchTargetCount,
      currentBatchSize: history.batch?.size,
    });

    if (!bulkOperation.id) {
      throw new Error("Shopify did not return a bulk operation id.");
    }
    const responseReceivedSet = await db.editHistory.updateMany({
      where: {
        id: historyId,
        shop: this.session.shop,
        executionState: { in: CAS_MUTABLE_EXECUTION_STATES },
      },
      data: {
        batch: rememberBatch(mergeCurrentBatch({
          shopifySubmissionIntent: {
            ...submissionIntent,
            submissionStage: "SUBMIT_RESPONSE_RECEIVED",
            stagedUploadPath,
            stagedUploadPathHash,
            bulkOperationId: bulkOperation.id,
            userErrors: bulkErrors,
          },
        })),
      },
    });
    if (responseReceivedSet.count !== 1) {
      throw new Error("SHOPIFY_SUBMISSION_RESPONSE_TRANSITION_REJECTED");
    }
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
        stagedUploadPathHash,
        shopifyBulkOperationId: bulkOperation.id,
        shopifyStatus: bulkOperation.status || null,
        shopifyType: bulkOperation.type || null,
        userErrors: bulkErrors,
        adaptiveSizing,
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
          executionState: { in: CAS_MUTABLE_EXECUTION_STATES },
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
          batch: rememberBatch(mergeCurrentBatch({
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
              userErrors: bulkErrors,
            },
            shopifyBulkOperationId: bulkOperation.id,
            submittedBatchId: batchId,
            lastProductId,
            hasMore,
            nextRetryCursorIndex,
            lastSubmittedAt: submittedAt.toISOString(),
            size: adaptiveSizing.nextBatchSize,
            dynamicBatchSizing: {
              ...adaptiveSizing,
              updatedAt: submittedAt.toISOString(),
            },
          })),
        },
      });
      return updated;
    });
    if (Number(finalizeResult?.count || 0) !== 1) {
      throw new Error("SHOPIFY_SUBMISSION_FINALIZE_CONFLICT");
    }

    await this.cacheSet(`${this.session.shop}:PRODUCT_UPDATE`, {
      running: true,
      historyId,
      bulkOperationId: bulkOperation.id,
    });
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
        adaptiveSizing,
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
}
