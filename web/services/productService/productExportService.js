import { EXPORT_TYPES } from "../../config/constants.js";
import { getCache, setCache } from "../../utils/cacheUtils.js";
import { db } from "../../repositories/repositoryDb.js";
import { TargetingEngineService } from "../targeting/TargetingEngineService.js";
import {
  assertSupportedExportFields,
  EXPORT_FIELD_GRANULARITY,
} from "./productExportFieldRegistry.js";
import {
  EXPORT_EXECUTION_STATES,
} from "../exportExecutionStateService.js";
import { projectExportHistoryStatus } from "../historyStatusProjectionService.js";
import {
  normalizeExportJobExecutionState,
  normalizeExportJobStatus,
} from "../../utils/normalizedStateUtils.js";
import {
  EXPORT_JOB_DETAIL_SELECT,
  EXPORT_JOB_LIST_SELECT,
  withDerivedExportProgress,
} from "./exportJobSelectors.js";
import { addbulkExportJob } from "../../Jobs/Queues/bulkExportJob.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
import {
  acquireExclusiveShopWork,
  releaseExclusiveShopWork,
  LOCK_NS,
} from "../shopWorkLeaseService.js";
import {
  buildIdempotencyRequestHash,
  IdempotencyStoreService,
} from "../idempotency/IdempotencyStoreService.js";

export class ProductExportService {
  constructor(session) {
    this.session = session;
    this.idempotencyStore = new IdempotencyStoreService(db);
  }

  _assertSupportedExportFields(fields = [], options = {}) {
    return assertSupportedExportFields(fields, options).map((field) => field.key);
  }

  _checkValidation(count, activePlan) {
    if (activePlan === "Basic (Monthly)") {
      if (count > 50) {
        throw new Error(
          "You are a basic plan user, you can only export 50 products at a time"
        );
      }
    } else if (activePlan === "Advanced (Monthly)") {
      if (count > 150) {
        throw new Error(
          "You are a pro plan user, you can only export 100 products at a time"
        );
      }
    }
  }

  async getAllExportHistories({
    lang = "en",
    type = null,
    cursor = null,
    limit = 20,
  } = {}) {
    const normalizedLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const normalizedType = String(type || "").trim().toLowerCase();
    const cacheKey = `${this.session.shop}:fetchExportHistories:${lang}:${normalizedType}:${cursor || "root"}:${normalizedLimit}`;

    const cacheHistories = await getCache(cacheKey);
    if (cacheHistories) return cacheHistories;

    const where = { shop: this.session.shop };
    if (normalizedType.includes("scheduled")) {
      where.type = { in: ["Scheduled export", "scheduled export", "Scheduled Export"] };
    } else if (normalizedType.includes("manual")) {
      where.type = { in: ["Manual export", "manual export", "Manual Export"] };
    }

    let cursorFilter = {};
    if (cursor) {
      const cursorRow = await db.exportJob.findFirst({
        where: { id: cursor, shop: this.session.shop },
        select: { id: true, createdAt: true },
      });
      if (cursorRow) {
        cursorFilter = {
          OR: [
            { createdAt: { lt: cursorRow.createdAt } },
            { AND: [{ createdAt: cursorRow.createdAt }, { id: { lt: cursorRow.id } }] },
          ],
        };
      }
    }

    const [rows, totalCount] = await Promise.all([
      db.exportJob.findMany({
        where: {
          AND: [where, ...(Object.keys(cursorFilter).length ? [cursorFilter] : [])],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: normalizedLimit + 1,
        select: EXPORT_JOB_LIST_SELECT,
      }),
      db.exportJob.count({ where }),
    ]);

    const hasNextPage = rows.length > normalizedLimit;
    const histories = hasNextPage ? rows.slice(0, normalizedLimit) : rows;
    const endCursor = histories.length ? histories[histories.length - 1].id : null;

    const items = histories.map((history) =>
      projectExportHistoryStatus({
        ...withDerivedExportProgress(history),
        rawType: history.type || "",
        type: EXPORT_TYPES[history.type]?.[lang] || history.type || "",
      }),
    );

    const result = {
      items,
      pageInfo: {
        hasNextPage,
        hasPreviousPage: Boolean(cursor),
        endCursor,
        nextCursor: hasNextPage ? endCursor : null,
        previousCursor: null,
      },
      totalCount,
    };

    await setCache(cacheKey, result, 120);
    return result;
  }

  async getExportHistoryDetails(input) {
    const exportJobId =
      typeof input === "string" ? input : input?.exportJobId || input?.id;
    const shop = this.session.shop;

    if (!exportJobId || exportJobId === "undefined" || exportJobId === "null") {
      throw new Error("Invalid export history ID");
    }

    const history = await db.exportJob.findFirst({
      where: {
        id: exportJobId,
        shop,
      },
      select: EXPORT_JOB_DETAIL_SELECT,
    });

    if (!history) {
      throw new Error("export history not found");
    }

    return {
      ...withDerivedExportProgress(history),
      rawType: history.type || "",
    };
  }

  async createExportJob({
    fields,
    fileName,
    filterParams,
    filterAst = null,
    options = null,
    actor = null,
    entitlementSnapshot = null,
    idempotencyKey = null,
  }) {
    const targetGranularity =
      String(options?.targetGranularity || EXPORT_FIELD_GRANULARITY.PRODUCT)
        .trim()
        .toUpperCase() === EXPORT_FIELD_GRANULARITY.VARIANT
        ? EXPORT_FIELD_GRANULARITY.VARIANT
        : EXPORT_FIELD_GRANULARITY.PRODUCT;
    const normalizedFields = this._assertSupportedExportFields(fields, {
      targetGranularity,
    });

    const normalizedIdempotencyKey = String(idempotencyKey || "").trim();
    if (!normalizedIdempotencyKey) {
      const error = new Error("IDEMPOTENCY_KEY_REQUIRED");
      error.code = "IDEMPOTENCY_KEY_REQUIRED";
      throw error;
    }
    const begin = await this.idempotencyStore.begin({
      shop: this.session.shop,
      scope: "EXPORT_CREATE",
      key: normalizedIdempotencyKey,
      requestHash: buildIdempotencyRequestHash({
        shop: this.session.shop,
        operationType: "EXPORT_CREATE",
        fields: normalizedFields,
        fileName,
        filterParams,
        filterAst,
        targetGranularity,
      }),
    });
    if (begin.mode === "replay") {
      return begin.response;
    }

    const filename = fileName?.endsWith(".csv") ? fileName : `${fileName}.csv`;
    const shop = this.session.shop;
    let writeCatalogLock = null;
    let jobId = null;

    const active = await db.exportJob.findFirst({
      where: {
        shop,
        statusNormalized: normalizeExportJobStatus("PROCESSING"),
        executionStateNormalized: {
          in: [
            normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.RUNNING),
          ],
        },
      },
    });
    if (active) {
      throw new Error("Another export is already running for this shop");
    }

    writeCatalogLock = await acquireExclusiveShopWork({
      shop,
      namespace: LOCK_NS.WRITE_CATALOG,
      activity: "manual_export_prepare",
      worker: "ProductExportService.createExportJob",
      queue: "api",
    });
    if (!writeCatalogLock.acquired) {
      throw new Error("Another catalog write operation is already running. Please retry shortly.");
    }
    try {
      const created = await db.$transaction(async (tx) => {
        const job = await tx.exportJob.create({
          data: {
            shop,
            filename,
            fields: normalizedFields,
            filterQuery: "{}",
            targetGranularity,
            status: "PENDING",
            statusNormalized: normalizeExportJobStatus("PENDING"),
            executionState: EXPORT_EXECUTION_STATES.PLANNED,
            executionStateNormalized: normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.PLANNED),
            entitlementSnapshot,
            actorType: actor?.actorType || null,
            actorId: actor?.actorId || null,
            actorEmail: actor?.actorEmail || null,
            actorName: actor?.actorName || null,
          },
        });

        const resolvedTarget = await TargetingEngineService.resolveAndFreezeExportTargets({
          shop,
          source: "EXPORT",
          targetType: targetGranularity,
          targetGranularity,
          filterAst,
          legacyFilterParams: Array.isArray(filterParams) ? filterParams : [],
          ownerType: "EXPORT_JOB",
          ownerId: job.id,
          mutationIntent: {
            operationType: "EXPORT",
            mutationType: "CSV_EXPORT",
            mutationPayload: {
              fields: normalizedFields,
              targetGranularity,
              filename,
            },
            targetGranularity,
          },
          queryParams: { cursor: null, limit: 20 },
          sampleLimit: 20,
          db: tx,
        });
        const frozenCount = Number(resolvedTarget.frozenCount || 0);

        await tx.exportJob.update({
          where: { id: job.id },
          data: {
            targetSnapshotCount: frozenCount,
            executionState: EXPORT_EXECUTION_STATES.PLANNED,
            executionStateNormalized: normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.PLANNED),
          },
        });

        return { jobId: job.id };
      });
      jobId = created.jobId;

      await db.exportJob.update({
        where: { id: jobId },
        data: {
          executionState: EXPORT_EXECUTION_STATES.QUEUED,
          executionStateNormalized: normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.QUEUED),
        },
      });
      await clearKeyCaches(`${shop}:fetchExportHistories:`);

      await releaseExclusiveShopWork(writeCatalogLock?.lockKey);
      writeCatalogLock = null;

      try {
        await addbulkExportJob(
          {
            exportJobId: jobId,
            shop,
            fields: normalizedFields,
            source: "manual_export",
            executionId: jobId,
          },
          {
            jobId: `product-export:${shop}:${jobId}`,
          },
        );
      } catch (enqueueError) {
        await db.exportJob.updateMany({
          where: {
            id: jobId,
            shop,
            statusNormalized: normalizeExportJobStatus("PENDING"),
            executionStateNormalized: {
              in: [
                normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.PLANNED),
                normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.QUEUED),
              ],
            },
          },
          data: {
            status: "FAILED",
            statusNormalized: normalizeExportJobStatus("FAILED"),
            executionState: EXPORT_EXECUTION_STATES.FAILED,
            executionStateNormalized: normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.FAILED),
            failureStage: "queue_enqueue",
            error: enqueueError?.message || "Export queue enqueue failed",
            completedAt: new Date(),
          },
        });
        await clearKeyCaches(`${shop}:fetchExportHistories:`);
        throw enqueueError;
      }

      const response = await db.exportJob.findFirst({
        where: {
          id: jobId,
          shop: this.session.shop,
        },
      });
      await this.idempotencyStore.complete({
        recordId: begin.recordId,
        response,
      });
      return response;
    } finally {
      await releaseExclusiveShopWork(writeCatalogLock?.lockKey);
    }
  }
}

