import { NotFoundError } from "../../utils/errorUtils.js";
import { EDIT_TYPES, FIELD_TRANSLATIONS } from "../../config/constants.js";
import { getCache, setCache } from "../../utils/cacheUtils.js";
import { db } from "../../repositories/repositoryDb.js";
import { projectEditHistoryStatus } from "../historyStatusProjectionService.js";
import { assertSnapshotItemsFullyIngested } from "../targetSnapshotItemIntegrityService.js";

const validTypes = [
  "Manual edit",
  "Scheduled edit",
  "Recurring edit",
  "Automatic rule",
];

function getLocalizedJsonText(value, lang = "en") {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value !== "object" || Array.isArray(value)) {
    return String(value);
  }

  return value[lang] ?? value.en ?? Object.values(value)[0] ?? null;
}

function toNonNegativeInt(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.trunc(parsed));
}

function buildUndoResultProjection(snapshot) {
  if (!snapshot) return null;
  const payload =
    snapshot.undoMutation && typeof snapshot.undoMutation === "object"
      ? snapshot.undoMutation
      : {};
  return {
    status: String(snapshot.undoStatus || "NOT_REQUIRED").toLowerCase(),
    verified: payload.verified === true,
    verifiedAt: payload.verifiedAt || snapshot.undoneAt || null,
    fields: Array.isArray(payload.fields) ? payload.fields : [],
    errorCode: snapshot.undoErrorCode || null,
    errorMessage: snapshot.undoErrorMessage || null,
  };
}

function buildIngestionSummaryFields(
  batch,
  targetSnapshotCount,
  processedCount
) {
  const initialSource =
    batch &&
    typeof batch === "object" &&
    batch.ingestionSummary &&
    typeof batch.ingestionSummary === "object"
      ? batch.ingestionSummary
      : {};
  const completedSource =
    batch &&
    typeof batch === "object" &&
    batch.resultIngestion &&
    typeof batch.resultIngestion === "object" &&
    batch.resultIngestion.ingestedAt
      ? batch.resultIngestion
      : null;

  const totalTargets = toNonNegativeInt(
    initialSource.totalTargets,
    toNonNegativeInt(targetSnapshotCount || 0, 0)
  );
  const submittedCount = toNonNegativeInt(
    completedSource?.rowCount,
    toNonNegativeInt(
      initialSource.submittedCount,
      toNonNegativeInt(processedCount || 0, 0)
    )
  );
  const successCount = toNonNegativeInt(
    completedSource?.successCount,
    toNonNegativeInt(initialSource.successCount, 0)
  );
  const failedCount = toNonNegativeInt(
    completedSource?.failureCount,
    toNonNegativeInt(initialSource.failedCount, 0)
  );
  const retryableFailureCount = toNonNegativeInt(
    initialSource.retryableFailureCount,
    0
  );
  const permanentFailureCount = toNonNegativeInt(
    initialSource.permanentFailureCount,
    0
  );
  const skippedCount = toNonNegativeInt(
    completedSource
      ? Math.max(totalTargets - submittedCount, 0)
      : initialSource.skippedCount,
    Math.max(totalTargets - submittedCount, 0)
  );

  return {
    ingestionTotalTargets: totalTargets,
    ingestionSubmittedCount: submittedCount,
    ingestionSuccessCount: successCount,
    ingestionFailedCount: failedCount,
    ingestionSkippedCount: skippedCount,
    ingestionRetryableFailureCount: retryableFailureCount,
    ingestionPermanentFailureCount: permanentFailureCount,
  };
}

async function getEditExecutionCounts({
  shop,
  historyId,
  snapshotSetId = null,
}) {
  if (snapshotSetId) {
    const grouped = await db.targetSnapshotItem
      .groupBy({
        by: ["executionStatus"],
        where: {
          shop,
          snapshotSetId,
        },
        _count: {
          _all: true,
        },
      })
      .catch(() => []);

    return (Array.isArray(grouped) ? grouped : []).reduce(
      (acc, row) => {
        const status = String(row?.executionStatus || "").toUpperCase();
        const count = toNonNegativeInt(row?._count?._all || 0, 0);
        if (status === "SUCCEEDED")
          acc.successCount += count;
        else if (status === "FAILED") acc.failedCount += count;
        else if (status === "SKIPPED") acc.skippedCount += count;
        acc.totalCount += count;
        return acc;
      },
      { totalCount: 0, successCount: 0, failedCount: 0, skippedCount: 0 }
    );
  }

  const grouped = await db.changeRecord
    .groupBy({
      by: ["status"],
      where: {
        shop,
        editHistoryId: historyId,
      },
      _count: {
        _all: true,
      },
    })
    .catch(() => []);

  return (Array.isArray(grouped) ? grouped : []).reduce(
    (acc, row) => {
      const status = String(row?.status || "").toUpperCase();
      const count = toNonNegativeInt(row?._count?._all || 0, 0);
      if (["SUCCEEDED", "SUCCESS", "COMPLETED"].includes(status))
        acc.successCount += count;
      else if (status === "FAILED") acc.failedCount += count;
      else if (status === "SKIPPED") acc.skippedCount += count;
      acc.totalCount += count;
      return acc;
    },
    { totalCount: 0, successCount: 0, failedCount: 0, skippedCount: 0 }
  );
}

function buildIdempotencyStageFields(batch) {
  const stages =
    batch &&
    typeof batch === "object" &&
    batch.idempotencyStages &&
    typeof batch.idempotencyStages === "object"
      ? batch.idempotencyStages
      : {};
  const projected = Object.entries(stages)
    .map(([stage, value]) => {
      const stageState = value && typeof value === "object" ? value : {};
      return {
        stage,
        key: stageState.key || null,
        status: stageState.status || null,
        attempts: toNonNegativeInt(stageState.attempts, 0),
        startedAt: stageState.startedAt || null,
        updatedAt: stageState.updatedAt || null,
        completedAt: stageState.completedAt || null,
        leaseUntil: stageState.leaseUntil || null,
        recovered: stageState.recovered === true,
        checkpoint: stageState.checkpoint ?? null,
        error: stageState.error || null,
      };
    })
    .sort((a, b) => String(a.stage).localeCompare(String(b.stage)));

  return {
    idempotencyStages: projected,
  };
}

function normalizeShopifyBulkStatus(executionState, shopifyBulkOperationId) {
  const state = String(executionState || "").toUpperCase();
  if (!shopifyBulkOperationId) return "NOT_SUBMITTED";
  if (state === "SHOPIFY_BULK_SUBMITTED") return "SUBMITTED";
  if (state === "SHOPIFY_RUNNING") return "RUNNING";
  if (state === "SHOPIFY_COMPLETED") return "COMPLETED";
  if (state === "FAILED") return "FAILED";
  if (state === "CANCELLED") return "CANCELLED";
  return "UNKNOWN";
}

function buildSnapshotReference(record) {
  const batch =
    record?.batch && typeof record.batch === "object" ? record.batch : {};
  const batchRef =
    batch?.targetSnapshotRef && typeof batch.targetSnapshotRef === "object"
      ? batch.targetSnapshotRef
      : {};
  const set =
    record?.snapshotSet && typeof record.snapshotSet === "object"
      ? record.snapshotSet
      : null;
  const lifecycleSnapshotSetId =
    String(record?.snapshotSetId || "").trim() || null;
  const batchSnapshotSetId =
    String(batchRef?.snapshotSetId || "").trim() || null;
  const snapshotSetId =
    lifecycleSnapshotSetId || batchSnapshotSetId || set?.id || null;

  return {
    previewContractId:
      String(set?.previewContracts?.[0]?.id || "").trim() ||
      String(batch?.previewContractId || "").trim() ||
      String(batch?.previewId || "").trim() ||
      null,
    snapshotSetId,
    mirrorBatchId:
      String(set?.mirrorBatchId || "").trim() ||
      String(record?.targetProductMirrorBatchId || "").trim() ||
      String(batchRef?.mirrorBatchId || "").trim() ||
      null,
    targetDefinitionHash:
      String(set?.targetDefinitionHash || "").trim() ||
      String(batch?.previewFingerprint?.normalizedFilterHash || "").trim() ||
      null,
    targetCount: Number(set?.targetCount || record?.targetSnapshotCount || 0),
    productCount: Number(set?.productCount || 0),
    variantCount: Number(set?.variantCount || 0),
    inventoryItemCount: Number(set?.inventoryItemCount || 0),
    metafieldCount: Number(set?.metafieldCount || 0),
    mutationCounts: {
      pending: Number(set?.mutationPendingCount || 0),
      submitted: Number(set?.mutationSubmittedCount || 0),
      succeeded: Number(set?.mutationSucceededCount || 0),
      failed: Number(set?.mutationFailedCount || 0),
      skipped: Number(set?.mutationSkippedCount || 0),
    },
    verificationCounts: {
      pending: Number(set?.verificationPendingCount || 0),
      succeeded: Number(set?.verificationSucceededCount || 0),
      failed: Number(set?.verificationFailedCount || 0),
    },
    undoCounts: {
      notRequired: Number(set?.undoNotRequiredCount || 0),
      pending: Number(set?.undoPendingCount || 0),
      submitted: Number(set?.undoSubmittedCount || 0),
      succeeded: Number(set?.undoSucceededCount || 0),
      failed: Number(set?.undoFailedCount || 0),
      skipped: Number(set?.undoSkippedCount || 0),
    },
    targetSetHash:
      String(set?.targetSetHash || "").trim() ||
      String(batchRef?.targetSetHash || batchRef?.checksum || "").trim() ||
      null,
    freezeStatus:
      String(set?.status || "").trim() ||
      String(batchRef?.status || "").trim() ||
      null,
    executionStatus:
      String(
        record?.executionStateNormalized || record?.executionState || ""
      ).trim() || null,
    undoStatus: String(record?.undo?.executionState || record?.undo?.state || "").trim() || null,
    frozenAt: set?.frozenAt || null,
    submittedAt: record?.batch?.shopifyBulkOperationSubmittedAt || null,
    completedAt: record?.completedAt || null,
    createdAt: record?.createdAt || null,
  };
}

function buildExecutionTransparencyFields({ history, changeStatusCounts }) {
  const batch =
    history?.batch && typeof history.batch === "object" ? history.batch : {};
  const executionPlan =
    batch?.executionPlan && typeof batch.executionPlan === "object"
      ? batch.executionPlan
      : {};
  const targetTotal = toNonNegativeInt(
    history?.targetSnapshotCount ?? history?.totalItems ?? 0,
    0
  );
  const processed = toNonNegativeInt(history?.processedCount || 0, 0);
  const failedCount = toNonNegativeInt(changeStatusCounts?.FAILED || 0, 0);
  const successCount = toNonNegativeInt(
    (changeStatusCounts?.SUCCESS || 0) + (changeStatusCounts?.SUCCEEDED || 0),
    0
  );
  const pendingCount = toNonNegativeInt(changeStatusCounts?.PENDING || 0, 0);
  const directSucceeded =
    String(batch.executionMode || "").toUpperCase() === "DIRECT" &&
    String(history?.executionStateNormalized || "").toUpperCase() === "COMPLETED" &&
    successCount > 0 &&
    failedCount === 0;
  const explicitVerifiedCount = toNonNegativeInt(
    changeStatusCounts?.VERIFIED ?? batch.verifiedCount ?? 0,
    0
  );
  const verifiedCount =
    explicitVerifiedCount || (directSucceeded ? successCount : 0);
  const directGraphqlExecution =
    String(batch.executionMode || "").toUpperCase() === "DIRECT" &&
    processed > 0;
  const submittedToShopify =
    Boolean(history?.shopifyBulkOperationId) || directGraphqlExecution;
  const verificationStatus = String(
    batch.verificationStatus || (directSucceeded ? "PASSED" : "UNKNOWN")
  ).toUpperCase();
  const ingestion = buildIngestionSummaryFields(batch, targetTotal, processed);

  return {
    executionTransparency: {
      targetFreezeProgress: {
        frozen: targetTotal,
        total: targetTotal,
      },
      executionPlan: {
        operationKey:
          batch?.operationKey || executionPlan?.operationKey || null,
        mutationType: executionPlan?.mutationType || null,
        apiStrategy: executionPlan?.apiStrategy || null,
        targetResourceType: executionPlan?.targetResourceType || null,
        riskLevel: executionPlan?.riskLevel || null,
      },
      shopifySubmission: {
        submitted: submittedToShopify,
        shopifyBulkOperationId: history?.shopifyBulkOperationId || null,
      },
      shopifyBulkOperationStatus: directGraphqlExecution
        ? String(history?.executionStateNormalized || "UNKNOWN").toUpperCase()
        : normalizeShopifyBulkStatus(
            history?.executionStateNormalized,
            history?.shopifyBulkOperationId
          ),
      resultIngestionProgress: {
        submittedCount: ingestion.ingestionSubmittedCount,
        successCount: ingestion.ingestionSuccessCount,
        failedCount: ingestion.ingestionFailedCount,
        skippedCount: ingestion.ingestionSkippedCount,
        retryableFailureCount: ingestion.ingestionRetryableFailureCount,
        permanentFailureCount: ingestion.ingestionPermanentFailureCount,
      },
      itemLevelFailures: {
        failedCount,
        pendingCount,
      },
      verificationStatus: {
        status: verificationStatus,
        verifiedCount,
        successCount,
      },
      processed: {
        current: processed,
        total: targetTotal,
      },
      undoAvailability: {
        available: history?.undo?.allowed === true,
      },
    },
  };
}

export class EditHistoryService {
  constructor(session, activePlan) {
    this.session = session;
    this.plan = activePlan?.name || "Basic";
  }

  getDateLimit() {
    const planDurations = {
      "Basic (Monthly)": 60,
      "Basic (Yearly)": 60,
      "Advanced (Monthly)": 90,
      "Advanced (Yearly)": 90,
      "Pro (Monthly)": 180,
      "Pro (Yearly)": 180,
    };

    const days = planDurations[this.plan] || 0;
    const date = new Date();
    date.setDate(date.getDate() - days);

    return { dateLimit: date, planLimit: days };
  }

  async getEditHistories({ type, search, cursor, limit = 10, lang }) {
    try {
      const where = {
        shop: this.session.shop,
        ...(type === "Favorites"
          ? { isFavourite: true }
          : validTypes.includes(type)
          ? { type }
          : {}),
      };

      const limitNumber = Math.max(1, parseInt(limit, 10));

      let cursorFilter = {};
      if (cursor) {
        const cursorRecord = await db.editHistory.findFirst({
          where: {
            id: cursor,
            shop: this.session.shop,
          },
          select: { id: true, createdAt: true },
        });

        if (cursorRecord) {
          cursorFilter = {
            OR: [
              { createdAt: { lt: cursorRecord.createdAt } },
              {
                AND: [
                  { createdAt: cursorRecord.createdAt },
                  { id: { lt: cursorRecord.id } },
                ],
              },
            ],
          };
        }
      }

      const queryWhere =
        Object.keys(cursorFilter).length > 0
          ? {
              AND: [where, cursorFilter],
            }
          : where;

      const records = await db.editHistory.findMany({
        where: queryWhere,
        select: {
          id: true,
          title: true,
          status: true,
          statusNormalized: true,
          executionState: true,
          executionStateNormalized: true,
          executionIdentity: true,
          targetSnapshotCount: true,
          targetProductMirrorBatchId: true,
          failureStage: true,
          cancelRequestedAt: true,
          cancelledAt: true,
          cancelReason: true,
          pauseRequestedAt: true,
          pausedAt: true,
          resumedAt: true,
          processedCount: true,
          totalItems: true,
          requestedAt: true,
          shop: true,
          undo: true,
          batch: true,
          error: true,
          createdAt: true,
          updatedAt: true,
          completedAt: true,
          snapshotSetId: true,
          snapshotSet: {
            select: {
              id: true,
              previewContracts: {
                orderBy: { revision: "desc" },
                take: 1,
                select: { id: true },
              },
              mirrorBatchId: true,
              targetDefinitionHash: true,
              targetCount: true,
              productCount: true,
              variantCount: true,
              inventoryItemCount: true,
              metafieldCount: true,
              mutationPendingCount: true,
              mutationSubmittedCount: true,
              mutationSucceededCount: true,
              mutationFailedCount: true,
              mutationSkippedCount: true,
              verificationPendingCount: true,
              verificationSucceededCount: true,
              verificationFailedCount: true,
              undoNotRequiredCount: true,
              undoPendingCount: true,
              undoSubmittedCount: true,
              undoSucceededCount: true,
              undoFailedCount: true,
              undoSkippedCount: true,
              targetSetHash: true,
              status: true,
              frozenAt: true,
            },
          },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limitNumber + 1,
      });

      const hasNextPage = records.length > limitNumber;
      const edges = hasNextPage ? records.slice(0, -1) : records;

      const formattedData = edges.map((record) =>
        projectEditHistoryStatus({
          ...record,
          snapshotReference: buildSnapshotReference(record),
          title: getLocalizedJsonText(record.title, lang),
        })
      );

      const totalCount = await db.editHistory.count({
        where,
      });

      const returnData = {
        edges: formattedData,
        pageInfo: {
          hasNextPage,
          endCursor: edges.length > 0 ? edges[edges.length - 1].id : null,
        },
        totalCount,
      };

      return {
        ...returnData,
        ref: "Fetched edit histories successfully from database.",
      };
    } catch (error) {
      throw new Error("Error fetching history records: " + error.message);
    }
  }

  async getHistoryDetails(id, lang) {
    try {
      if (!id || id === "undefined" || id === "null") {
        throw new NotFoundError(
          `Invalid history ID format: ${id}`,
          "Invalid ID"
        );
      }

      const history = await db.editHistory.findFirst({
        where: {
          id,
          shop: this.session.shop,
        },
        select: {
          id: true,
          title: true,
          status: true,
          statusNormalized: true,
          executionState: true,
          executionStateNormalized: true,
          executionIdentity: true,
          targetSnapshotCount: true,
          targetProductMirrorBatchId: true,
          failureStage: true,
          cancelRequestedAt: true,
          cancelledAt: true,
          cancelReason: true,
          pauseRequestedAt: true,
          pausedAt: true,
          resumedAt: true,
          durationMs: true,
          processedCount: true,
          totalItems: true,
          requestedAt: true,
          createdAt: true,
          updatedAt: true,
          completedAt: true,
          shopifyBulkOperationId: true,
          error: true,
          undo: true,
          batch: true,
          editType: true,
          shop: true,
          rules: true,
          snapshotSetId: true,
          snapshotSet: {
            select: {
              id: true,
              previewContracts: {
                orderBy: { revision: "desc" },
                take: 1,
                select: { id: true },
              },
              mirrorBatchId: true,
              targetDefinitionHash: true,
              targetCount: true,
              productCount: true,
              variantCount: true,
              inventoryItemCount: true,
              metafieldCount: true,
              mutationPendingCount: true,
              mutationSubmittedCount: true,
              mutationSucceededCount: true,
              mutationFailedCount: true,
              mutationSkippedCount: true,
              verificationPendingCount: true,
              verificationSucceededCount: true,
              verificationFailedCount: true,
              undoNotRequiredCount: true,
              undoPendingCount: true,
              undoSubmittedCount: true,
              undoSucceededCount: true,
              undoFailedCount: true,
              undoSkippedCount: true,
              targetSetHash: true,
              status: true,
              frozenAt: true,
            },
          },
        },
      });

      if (!history) {
        throw new NotFoundError(
          `History record ${id} not found`,
          "History not found"
        );
      }

      const rules = Array.isArray(history.rules) ? history.rules : [];
      const rule = rules[0] ?? { field: "csv" };

      const returnData = projectEditHistoryStatus({
        ...history,
        snapshotReference: buildSnapshotReference(history),
        title: getLocalizedJsonText(history.title, lang),
        field:
          FIELD_TRANSLATIONS?.[rule?.field]?.[lang] ??
          rule?.field ??
          "unknown_field",
        type:
          EDIT_TYPES?.[history.editType]?.[lang] ?? history.editType ?? "unknown_type",
      });

      const immutableEditCommand =
        history?.batch &&
        typeof history.batch === "object" &&
        history.batch.immutableEditCommand &&
        typeof history.batch.immutableEditCommand === "object"
          ? history.batch.immutableEditCommand
          : null;

      returnData.immutableEditCommand = immutableEditCommand;
      returnData.idempotencyKey = immutableEditCommand?.idempotencyKey || null;
      const groupedStatuses = await db.changeRecord
        .groupBy({
          by: ["status"],
          where: {
            editHistoryId: history.id,
            shop: history.shop,
          },
          _count: {
            _all: true,
          },
        })
        .catch(() => []);
      const changeStatusCounts = (
        Array.isArray(groupedStatuses) ? groupedStatuses : []
      ).reduce((acc, row) => {
        const key = String(row?.status || "").toUpperCase();
        if (!key) return acc;
        acc[key] = toNonNegativeInt(row?._count?._all || 0, 0);
        return acc;
      }, {});
      Object.assign(
        returnData,
        buildIngestionSummaryFields(
          history.batch,
          history.targetSnapshotCount,
          history.processedCount
        )
      );
      Object.assign(returnData, buildIdempotencyStageFields(history.batch));
      Object.assign(
        returnData,
        buildExecutionTransparencyFields({
          history,
          changeStatusCounts,
        })
      );
      returnData.supportStatus = {
        ...(returnData.supportStatus &&
        typeof returnData.supportStatus === "object"
          ? returnData.supportStatus
          : {}),
        idempotencyStages: returnData.idempotencyStages,
        executionTransparency: returnData.executionTransparency,
      };

      return returnData;
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      throw new Error("Error fetching history details: " + error.message);
    }
  }

  async getHistorySummary(id, lang) {
    try {
      if (!id || id === "undefined" || id === "null") {
        throw new NotFoundError(
          `Invalid history ID format: ${id}`,
          "Invalid ID"
        );
      }

      const history = await db.editHistory.findFirst({
        where: {
          id,
          shop: this.session.shop,
        },
        select: {
          id: true,
          title: true,
          status: true,
          statusNormalized: true,
          executionState: true,
          executionStateNormalized: true,
          failureStage: true,
          processedCount: true,
          totalItems: true,
          targetSnapshotCount: true,
          durationMs: true,
          shop: true,
          shopifyBulkOperationId: true,
          undo: true,
          batch: true,
          error: true,
          updatedAt: true,
          createdAt: true,
          completedAt: true,
          snapshotSetId: true,
          snapshotSet: {
            select: {
              id: true,
              previewContracts: {
                orderBy: { revision: "desc" },
                take: 1,
                select: { id: true },
              },
              mirrorBatchId: true,
              targetDefinitionHash: true,
              targetCount: true,
              productCount: true,
              variantCount: true,
              inventoryItemCount: true,
              metafieldCount: true,
              mutationPendingCount: true,
              mutationSubmittedCount: true,
              mutationSucceededCount: true,
              mutationFailedCount: true,
              mutationSkippedCount: true,
              verificationPendingCount: true,
              verificationSucceededCount: true,
              verificationFailedCount: true,
              undoNotRequiredCount: true,
              undoPendingCount: true,
              undoSubmittedCount: true,
              undoSucceededCount: true,
              undoFailedCount: true,
              undoSkippedCount: true,
              targetSetHash: true,
              status: true,
              frozenAt: true,
            },
          },
        },
      });

      if (!history) {
        throw new NotFoundError(
          `History record ${id} not found`,
          "History not found"
        );
      }

      const snapshotSetId =
        String(history?.snapshotSetId || "").trim() ||
        String(history?.batch?.targetSnapshotRef?.snapshotSetId || "").trim();
      const executionCounts = await getEditExecutionCounts({
        shop: this.session.shop,
        historyId: history.id,
        snapshotSetId,
      });
      const groupedStatuses = await db.changeRecord
        .groupBy({
          by: ["status"],
          where: {
            editHistoryId: history.id,
            shop: history.shop,
          },
          _count: {
            _all: true,
          },
        })
        .catch(() => []);
      const changeStatusCounts = (
        Array.isArray(groupedStatuses) ? groupedStatuses : []
      ).reduce((acc, row) => {
        const key = String(row?.status || "").toUpperCase();
        if (!key) return acc;
        acc[key] = toNonNegativeInt(row?._count?._all || 0, 0);
        return acc;
      }, {});
      const totalCount =
        executionCounts.totalCount ||
        toNonNegativeInt(
          history.targetSnapshotCount || history.totalItems || 0,
          0
        );
      console.info("[history-summary]", {
        id: history.id,
        status: history.statusNormalized,
        totalCount,
        successCount: executionCounts.successCount,
        failedCount: executionCounts.failedCount,
      });

      const returnData = projectEditHistoryStatus({
        ...history,
        type: history.editType || "Manual edit",
        totalCount,
        successCount: executionCounts.successCount,
        failedCount: executionCounts.failedCount,
        skippedCount: executionCounts.skippedCount,
        snapshotReference: buildSnapshotReference(history),
        title: getLocalizedJsonText(history.title, lang),
      });
      Object.assign(
        returnData,
        buildIngestionSummaryFields(
          history.batch,
          history.targetSnapshotCount,
          history.processedCount
        )
      );
      Object.assign(returnData, buildIdempotencyStageFields(history.batch));
      Object.assign(
        returnData,
        buildExecutionTransparencyFields({
          history,
          changeStatusCounts,
        })
      );
      returnData.supportStatus = {
        ...(returnData.supportStatus &&
        typeof returnData.supportStatus === "object"
          ? returnData.supportStatus
          : {}),
        idempotencyStages: returnData.idempotencyStages,
        executionTransparency: returnData.executionTransparency,
      };

      return returnData;
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      throw new Error("Error fetching history summary: " + error.message);
    }
  }

  async getHistoryEditChanges(id, cursor = null, limit = 10) {
    try {
      if (!id || id === "undefined" || id === "null") {
        throw new NotFoundError(
          `Invalid history ID format: ${id}`,
          "Invalid ID"
        );
      }

      const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
      const cacheKey = `${this.session.shop}:historyChanges:${id}:cursor${
        cursor || "start"
      }:limit${limitNum}`;
      const cacheData = await getCache(cacheKey);

      const cachedTotalCount = toNonNegativeInt(cacheData?.totalCount, 0);
      if (
        cacheData &&
        (cachedTotalCount > 0 || cacheData?.changes?.length > 0)
      ) {
        return {
          changes: cacheData.changes,
          pageInfo: cacheData.pageInfo,
          totalCount: cacheData.totalCount,
          message: "Fetched history changes successfully from cache.",
        };
      }

      const history = await db.editHistory.findFirst({
        where: {
          id,
          shop: this.session.shop,
        },
        select: {
          id: true,
          snapshotSetId: true,
          executionIdentity: true,
          isSpreadsheetEdit: true,
          batch: true,
        },
      });

      if (!history) {
        throw new NotFoundError(
          `History record ${id} not found`,
          "History not found"
        );
      }

      const snapshotSetId =
        String(history?.snapshotSetId || "").trim() ||
        String(history?.batch?.targetSnapshotRef?.snapshotSetId || "").trim();

      // CSV imports already own durable ChangeRecord rows with the merchant-facing
      // field diffs. Older CSV snapshots may not contain plannedMutation, so using
      // them here would reject an otherwise successfully ingested import.
      if (snapshotSetId && history.isSpreadsheetEdit !== true) {
        const totalCount = await db.targetSnapshotItem.count({
          where: {
            shop: this.session.shop,
            snapshotSetId,
            executionStatus: {
              in: ["SUCCEEDED", "FAILED", "SKIPPED"],
            },
          },
        });

        let snapshotCursorWhere = {};
        if (cursor) {
          snapshotCursorWhere = {
            targetKey: { lt: String(cursor) },
          };
        }

        const rows = await db.targetSnapshotItem.findMany({
          where: {
            shop: this.session.shop,
            snapshotSetId,
            executionStatus: {
              in: ["SUCCEEDED", "FAILED", "SKIPPED"],
            },
            ...snapshotCursorWhere,
          },
          select: {
            id: true,
            targetKey: true,
            plannedMutation: true,
            beforeValues: true,
            executionStatus: true,
            productId: true,
            variantId: true,
            undoStatus: true,
            undoMutation: true,
            undoErrorCode: true,
            undoErrorMessage: true,
            undoneAt: true,
            createdAt: true,
          },
          orderBy: { targetKey: "desc" },
          take: limitNum + 1,
        });

        const hasNextPage = rows.length > limitNum;
        const pageRows = hasNextPage ? rows.slice(0, limitNum) : rows;
        assertSnapshotItemsFullyIngested(
          pageRows.filter(
            (row) => String(row.executionStatus || "") === "SUCCEEDED",
          ),
          "history_changes"
        );
        const endCursor = pageRows.length
          ? pageRows[pageRows.length - 1].targetKey
          : null;

        const changes = pageRows.map((row) => ({
          id: row.targetKey,
          title: row.beforeValues?.productTitle || row.targetKey,
          productFieldChanges: row.plannedMutation?.productFieldChanges || [],
          variantFieldChanges: row.plannedMutation?.variantFieldChanges || [],
          status: row.executionStatus,
          image: row.beforeValues?.image || null,
          productId: row.productId,
          variantId: row.variantId,
          createdAt: row.createdAt,
          undoResult: buildUndoResultProjection(row),
        }));

        const result = {
          changes,
          pageInfo: {
            hasNextPage,
            endCursor,
          },
          totalCount,
          limit: limitNum,
          message: "Fetched history changes successfully.",
        };

        if (totalCount > 0) {
          await setCache(cacheKey, result, 300);
        }
        return result;
      }

      const totalCount = await db.changeRecord.count({
        where: {
          editHistoryId: id,
          shop: this.session.shop,
        },
      });

      let cursorFilter = {};
      if (cursor) {
        const cursorRecord = await db.changeRecord.findFirst({
          where: {
            id: cursor,
            editHistoryId: id,
            shop: this.session.shop,
          },
          select: { id: true, createdAt: true },
        });

        if (cursorRecord) {
          cursorFilter = {
            OR: [
              { createdAt: { lt: cursorRecord.createdAt } },
              {
                AND: [
                  { createdAt: cursorRecord.createdAt },
                  { id: { lt: cursorRecord.id } },
                ],
              },
            ],
          };
        }
      }

      const rows = await db.changeRecord.findMany({
        where: {
          AND: [
            {
              editHistoryId: id,
              shop: this.session.shop,
            },
            ...(Object.keys(cursorFilter).length ? [cursorFilter] : []),
          ],
        },
        select: {
          id: true,
          title: true,
          productFieldChanges: true,
          variantFieldChanges: true,
          status: true,
          image: true,
          productId: true,
          variantId: true,
          targetIdentity: true,
          createdAt: true,
        },
        orderBy: {
          createdAt: "desc",
        },
        take: limitNum + 1,
      });

      const hasNextPage = rows.length > limitNum;
      const changes = hasNextPage ? rows.slice(0, limitNum) : rows;
      const undoSnapshots = snapshotSetId
        ? await db.targetSnapshotItem.findMany({
            where: {
              shop: this.session.shop,
              snapshotSetId,
              targetKey: {
                in: changes.map((row) => row.targetIdentity).filter(Boolean),
              },
            },
            select: {
              targetKey: true,
              undoStatus: true,
              undoMutation: true,
              undoErrorCode: true,
              undoErrorMessage: true,
              undoneAt: true,
            },
          })
        : [];
      const undoSnapshotByTarget = new Map(
        undoSnapshots.map((snapshot) => [snapshot.targetKey, snapshot])
      );
      const projectedChanges = changes.map((change) => ({
        ...change,
        undoResult: buildUndoResultProjection(
          undoSnapshotByTarget.get(change.targetIdentity)
        ),
      }));
      const endCursor = changes.length ? changes[changes.length - 1].id : null;

      const result = {
        changes: projectedChanges,
        pageInfo: {
          hasNextPage,
          endCursor,
        },
        totalCount,
        limit: limitNum,
        message: "Fetched history changes successfully.",
      };

      await setCache(cacheKey, result, 300);
      return result;
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      throw new Error("Error fetching history changes: " + error.message);
    }
  }
}
