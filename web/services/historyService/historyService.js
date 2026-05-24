import { NotFoundError } from "../../utils/errorUtils.js";
import { EDIT_TYPES, FIELD_TRANSLATIONS } from "../../config/constants.js";
import { getCache, setCache } from "../../utils/cacheUtils.js";
import { prisma } from "../../config/database.js";
import { projectEditHistoryStatus } from "../historyStatusProjectionService.js";

const validTypes = ["Manual edit", "Scheduled edit", "Recurring edit", "Automatic rule"];

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

function buildIngestionSummaryFields(batch, targetSnapshotCount, processedCount) {
  const source = batch && typeof batch === "object" && batch.ingestionSummary
    && typeof batch.ingestionSummary === "object"
    ? batch.ingestionSummary
    : {};

  const totalTargets = toNonNegativeInt(
    source.totalTargets,
    toNonNegativeInt(targetSnapshotCount || 0, 0),
  );
  const submittedCount = toNonNegativeInt(
    source.submittedCount,
    toNonNegativeInt(processedCount || 0, 0),
  );
  const successCount = toNonNegativeInt(source.successCount, 0);
  const failedCount = toNonNegativeInt(source.failedCount, 0);
  const retryableFailureCount = toNonNegativeInt(source.retryableFailureCount, 0);
  const permanentFailureCount = toNonNegativeInt(source.permanentFailureCount, 0);
  const skippedCount = toNonNegativeInt(
    source.skippedCount,
    Math.max(totalTargets - submittedCount, 0),
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

function buildIdempotencyStageFields(batch) {
  const stages = batch && typeof batch === "object" && batch.idempotencyStages
    && typeof batch.idempotencyStages === "object"
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

function normalizeShopifyBulkStatus(executionState, bulkOperationId) {
  const state = String(executionState || "").toUpperCase();
  if (!bulkOperationId) return "NOT_SUBMITTED";
  if (state === "SHOPIFY_BULK_SUBMITTED") return "SUBMITTED";
  if (state === "SHOPIFY_RUNNING") return "RUNNING";
  if (state === "SHOPIFY_COMPLETED") return "COMPLETED";
  if (state === "FAILED") return "FAILED";
  if (state === "CANCELLED") return "CANCELLED";
  return "UNKNOWN";
}

function buildExecutionTransparencyFields({
  history,
  changeStatusCounts,
}) {
  const batch = history?.batch && typeof history.batch === "object" ? history.batch : {};
  const executionPlan = batch?.executionPlan && typeof batch.executionPlan === "object"
    ? batch.executionPlan
    : {};
  const targetTotal = toNonNegativeInt(
    history?.targetSnapshotCount ?? history?.totalItems ?? 0,
    0,
  );
  const processed = toNonNegativeInt(history?.processedCount || 0, 0);
  const verifiedCount = toNonNegativeInt(changeStatusCounts?.VERIFIED || 0, 0);
  const failedCount = toNonNegativeInt(changeStatusCounts?.FAILED || 0, 0);
  const successCount = toNonNegativeInt(changeStatusCounts?.SUCCESS || 0, 0);
  const pendingCount = toNonNegativeInt(changeStatusCounts?.PENDING || 0, 0);
  const submittedToShopify = Boolean(history?.bulkOperationId);
  const verificationStatus = String(batch.verificationStatus || "UNKNOWN").toUpperCase();
  const ingestion = buildIngestionSummaryFields(batch, targetTotal, processed);

  return {
    executionTransparency: {
      targetFreezeProgress: {
        frozen: targetTotal,
        total: targetTotal,
      },
      executionPlan: {
        operationKey: batch?.operationKey || executionPlan?.operationKey || null,
        mutationType: executionPlan?.mutationType || null,
        apiStrategy: executionPlan?.apiStrategy || null,
        targetType: executionPlan?.targetType || null,
        riskLevel: executionPlan?.riskLevel || null,
      },
      shopifySubmission: {
        submitted: submittedToShopify,
        bulkOperationId: history?.bulkOperationId || null,
      },
      shopifyBulkOperationStatus: normalizeShopifyBulkStatus(
        history?.executionState,
        history?.bulkOperationId,
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
        const cursorRecord = await prisma.editHistory.findFirst({
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

      const records = await prisma.editHistory.findMany({
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
          targetMirrorBatchId: true,
          failureStage: true,
          cancelRequestedAt: true,
          cancelledAt: true,
          cancelReason: true,
          pauseRequestedAt: true,
          pausedAt: true,
          resumedAt: true,
          processedCount: true,
          totalItems: true,
          editTime: true,
          shop: true,
          undo: true,
          batch: true,
          error: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limitNumber + 1,
      });

      const hasNextPage = records.length > limitNumber;
      const edges = hasNextPage ? records.slice(0, -1) : records;

      const formattedData = edges.map((record) =>
        projectEditHistoryStatus({
          ...record,
          title: getLocalizedJsonText(record.title, lang),
        }),
      );

      const totalCount = await prisma.editHistory.count({
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
          "Invalid ID",
        );
      }

      const history = await prisma.editHistory.findFirst({
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
          targetMirrorBatchId: true,
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
          editTime: true,
          createdAt: true,
          updatedAt: true,
          completedAt: true,
          bulkOperationId: true,
          error: true,
          undo: true,
          batch: true,
          type: true,
          shop: true,
          rules: true,
        },
      });

      if (!history) {
        throw new NotFoundError(
          `History record ${id} not found`,
          "History not found",
        );
      }

      const rules = Array.isArray(history.rules) ? history.rules : [];
      const rule = rules[0] ?? { field: "csv" };

      const returnData = projectEditHistoryStatus({
        ...history,
        title: getLocalizedJsonText(history.title, lang),
        field:
          FIELD_TRANSLATIONS?.[rule?.field]?.[lang] ??
          rule?.field ??
          "unknown_field",
        type:
          EDIT_TYPES?.[history.type]?.[lang] ??
          history.type ??
          "unknown_type",
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
      const groupedStatuses = await prisma.changeRecord.groupBy({
        by: ["status"],
        where: {
          editHistoryId: history.id,
          shop: history.shop,
        },
        _count: {
          _all: true,
        },
      }).catch(() => []);
      const changeStatusCounts = (Array.isArray(groupedStatuses) ? groupedStatuses : []).reduce(
        (acc, row) => {
          const key = String(row?.status || "").toUpperCase();
          if (!key) return acc;
          acc[key] = toNonNegativeInt(row?._count?._all || 0, 0);
          return acc;
        },
        {},
      );
      Object.assign(
        returnData,
        buildIngestionSummaryFields(
          history.batch,
          history.targetSnapshotCount,
          history.processedCount,
        ),
      );
      Object.assign(returnData, buildIdempotencyStageFields(history.batch));
      Object.assign(returnData, buildExecutionTransparencyFields({
        history,
        changeStatusCounts,
      }));
      returnData.supportStatus = {
        ...(returnData.supportStatus && typeof returnData.supportStatus === "object"
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

  async getHistoryEditChanges(id, cursor = null, limit = 10) {
    try {
      if (!id || id === "undefined" || id === "null") {
        throw new NotFoundError(
          `Invalid history ID format: ${id}`,
          "Invalid ID",
        );
      }

      const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
      const cacheKey = `${this.session.shop}:historyChanges:${id}:cursor${cursor || "start"}:limit${limitNum}`;
      const cacheData = await getCache(cacheKey);

      if (cacheData) {
        return {
          changes: cacheData.changes,
          pageInfo: cacheData.pageInfo,
          totalCount: cacheData.totalCount,
          message: "Fetched history changes successfully from cache.",
        };
      }

      const history = await prisma.editHistory.findFirst({
        where: {
          id,
          shop: this.session.shop,
        },
        select: { id: true },
      });

      if (!history) {
        throw new NotFoundError(
          `History record ${id} not found`,
          "History not found",
        );
      }

      const totalCount = await prisma.changeRecord.count({
        where: {
          editHistoryId: id,
          shop: this.session.shop,
        },
      });

      let cursorFilter = {};
      if (cursor) {
        const cursorRecord = await prisma.changeRecord.findFirst({
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

      const rows = await prisma.changeRecord.findMany({
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
          createdAt: true,
        },
        orderBy: {
          createdAt: "desc",
        },
        take: limitNum + 1,
      });

      const hasNextPage = rows.length > limitNum;
      const changes = hasNextPage ? rows.slice(0, limitNum) : rows;
      const endCursor = changes.length ? changes[changes.length - 1].id : null;

      const result = {
        changes,
        pageInfo: {
          hasNextPage,
          endCursor,
        },
        totalCount,
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
