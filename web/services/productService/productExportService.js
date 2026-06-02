import { fieldMappings } from "../../utils/productExportUtils.js";
import { EXPORT_TYPES } from "../../config/constants.js";
import { getCache, setCache } from "../../utils/cacheUtils.js";
import { db } from "../../repositories/repositoryDb.js";
import { TargetingEngineService } from "../targeting/TargetingEngineService.js";
import {
  EXPORT_EXECUTION_STATES,
} from "../exportExecutionStateService.js";
import { projectExportHistoryStatus } from "../historyStatusProjectionService.js";
import { OPERATION_LIFECYCLE_STATES } from "../operationLifecycleStateMachine.js";
import {
  normalizeExportJobExecutionState,
  normalizeExportJobStatus,
} from "../../utils/normalizedStateUtils.js";
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
    this.fieldMappings = fieldMappings;
    this.idempotencyStore = new IdempotencyStoreService(db);
  }

  _assertSupportedExportFields(fields = []) {
    if (!Array.isArray(fields) || fields.length === 0) {
      const error = new Error("FIELDS_REQUIRED");
      error.code = "VALIDATION_FAILED";
      throw error;
    }
    const supported = new Set(Object.keys(this.fieldMappings || {}));
    for (const field of fields) {
      const key = String(field || "");
      if (!supported.has(key)) {
        const error = new Error(`Unsupported export field: ${key}`);
        error.code = "VALIDATION_FAILED";
        throw error;
      }
    }
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
      where.type = "scheduled export";
    } else if (normalizedType.includes("manual")) {
      where.type = "manual export";
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
        select: {
          id: true,
          filename: true,
          fileUrl: true,
          createdAt: true,
          completedAt: true,
          type: true,
          status: true,
          processedCount: true,
          targetSnapshotCount: true,
          progressPercent: true,
          durationMs: true,
          error: true,
        },
      }),
      db.exportJob.count({ where }),
    ]);

    const hasNextPage = rows.length > normalizedLimit;
    const histories = hasNextPage ? rows.slice(0, normalizedLimit) : rows;
    const endCursor = histories.length ? histories[histories.length - 1].id : null;

    const items = histories.map((history) =>
      projectExportHistoryStatus({
        ...history,
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

  async getExportHistoryDetails(id) {
  if (!id || id === "undefined" || id === "null") {
    throw new Error("Invalid export history ID");
  }

  const history = await db.exportJob.findFirst({
    where: {
      id,
      shop: this.session.shop,
    },
    select: {
      id: true,
      filename: true,
      type: true,
      status: true,
      totalItems: true,
      processedCount: true,
      targetSnapshotCount: true,
      durationMs: true,
      startedAt: true,
      completedAt: true,
      fields: true,
      fileUrl: true,
      error: true,
    },
  });

  if (!history) {
    throw new Error("export history not found");
  }

  return {
    ...history,
    rawType: history.type || "",
  };
}

  async createExportJob({
    fields,
    fileName,
    filterParams,
    filterAst = null,
    actor = null,
    entitlementSnapshot = null,
    idempotencyKey = null,
  }) {
    this._assertSupportedExportFields(fields);

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
        fields,
        fileName,
        filterParams,
        filterAst,
      }),
    });
    if (begin.mode === "replay") {
      return begin.response;
    }

    const filename = fileName?.endsWith(".csv") ? fileName : `${fileName}.csv`;
    const shop = this.session.shop;
    let writeCatalogLock = null;

    const active = await db.exportJob.findFirst({
      where: {
        shop,
        statusNormalized: normalizeExportJobStatus("PROCESSING"),
        executionStateNormalized: {
          in: [
            normalizeExportJobExecutionState("RUNNING"),
            normalizeExportJobExecutionState("FINALIZING"),
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
      const { jobId } = await db.$transaction(async (tx) => {
        const job = await tx.exportJob.create({
          data: {
            shop,
            filename,
            fields,
            filterQuery: "{}",
            status: "PENDING",
            statusNormalized: normalizeExportJobStatus("PENDING"),
            executionState: OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
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
          targetType: "PRODUCT",
          targetGranularity: "PRODUCT",
          filterAst,
          legacyFilterParams: Array.isArray(filterParams) ? filterParams : [],
          ownerType: "EXPORT_JOB",
          ownerId: job.id,
          mutationIntent: {
            operationType: "EXPORT",
            mutationType: "CSV_EXPORT",
            mutationPayload: {
              fields,
              filename,
            },
            targetGranularity: "PRODUCT",
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
            executionState: OPERATION_LIFECYCLE_STATES.TARGET_FROZEN,
            executionStateNormalized: normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.PLANNED),
          },
        });

        return { jobId: job.id };
      });

      await clearKeyCaches(`${shop}:fetchExportHistories:`);
      await addbulkExportJob({
        exportJobId: jobId,
        shop,
        fields,
        source: "manual_export",
        executionId: jobId,
      });
      await db.exportJob.update({
        where: { id: jobId },
        data: {
          executionState: OPERATION_LIFECYCLE_STATES.QUEUED,
          executionStateNormalized: normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.QUEUED),
        },
      });

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

