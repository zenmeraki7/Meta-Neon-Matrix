import { prisma } from "../config/database.js";

function getClient(db) {
  return db || prisma;
}

function assertId(id, label = "id") {
  if (!id || typeof id !== "string") {
    throw new Error(`${label} is required`);
  }
}

function assertShop(shop) {
  if (!shop || typeof shop !== "string") {
    throw new Error("shop is required");
  }
}

function assertString(value, label) {
  if (!value || typeof value !== "string") {
    throw new Error(`${label} is required`);
  }
}

function clampLimit(limit, fallback = 50, max = 100) {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

const TERMINAL_RUN_STATUSES = new Set(["SUCCESS", "FAILED", "SKIPPED"]);

function assertTerminalStatus(status) {
  if (!TERMINAL_RUN_STATUSES.has(status)) {
    throw new Error(`Invalid terminal automatic rule run status: ${status}`);
  }
}

function pickTransitionData(data = {}) {
  const allowedKeys = [
    "errorMessage",
    "matchedCount",
    "affectedCount",
    "editHistoryId",
    "mirrorBatchId",
  ];

  return allowedKeys.reduce((accumulator, key) => {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      accumulator[key] = data[key];
    }
    return accumulator;
  }, {});
}

function pickRunMutableData(data = {}) {
  const allowedKeys = [
    "editHistoryId",
    "matchedCount",
    "affectedCount",
    "errorMessage",
    "mirrorBatchId",
    "startedAt",
    "completedAt",
    "heartbeatAt",
    "processingToken",
    "processingOwner",
    "processingStartedAt",
    "attemptCount",
    "lastAttemptAt",
    "queuedAt",
  ];

  return allowedKeys.reduce((accumulator, key) => {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      accumulator[key] = data[key];
    }
    return accumulator;
  }, {});
}

function assertRunCreateData(data = {}) {
  assertId(data.automaticProductRuleId, "automaticProductRuleId");
  assertShop(data.shop);
  assertString(data.triggerSource, "triggerSource");
  assertString(data.executionKey, "executionKey");
  assertId(data.mirrorBatchId, "mirrorBatchId");
}

function pickRunCreateData(data = {}) {
  return {
    automaticProductRuleId: data.automaticProductRuleId,
    shop: data.shop,
    mirrorBatchId: data.mirrorBatchId,
    triggerSource: data.triggerSource,
    triggerReference: data.triggerReference ?? null,
    scheduledFor: data.scheduledFor ?? null,
    executionKey: data.executionKey,
    ruleSnapshot: data.ruleSnapshot ?? null,
    conditionsSnapshot: data.conditionsSnapshot ?? null,
    actionsSnapshot: data.actionsSnapshot ?? null,
    scopeTypeSnapshot: data.scopeTypeSnapshot ?? null,
    applyModeSnapshot: data.applyModeSnapshot ?? null,
  };
}

export const automaticProductRuleRunRepository = {
  async createUnsafeUnpinnedRun(data, db = prisma) {
    return getClient(db).automaticProductRuleRun.create({ data });
  },

  async createPendingRun(data, db = prisma) {
    assertRunCreateData(data);
    return getClient(db).automaticProductRuleRun.create({
      data: {
        ...pickRunCreateData(data),
        status: "PENDING",
        startedAt: null,
        completedAt: null,
      },
    });
  },

  async create(data, db = prisma) {
    return this.createPendingRun(data, db);
  },

  async findByIdUnsafeInternal(id, db = prisma) {
    throw new Error("findByIdUnsafeInternal is forbidden; use findByIdForShop");
  },

  async findByIdWithRuleUnsafeInternal(id, db = prisma) {
    throw new Error("findByIdWithRuleUnsafeInternal is forbidden; use findByIdWithRuleForShop");
  },

  async findByExecutionKeyForShop(executionKey, shop, db = prisma) {
    assertId(executionKey, "executionKey");
    assertShop(shop);
    return getClient(db).automaticProductRuleRun.findFirst({
      where: { executionKey, shop },
    });
  },

  async findByIdWithRuleForShop(id, shop, db = prisma) {
    assertId(id);
    assertShop(shop);
    return getClient(db).automaticProductRuleRun.findFirst({
      where: { id, shop },
      include: { automaticProductRule: true },
    });
  },

  async findByIdForShop(id, shop, db = prisma) {
    assertId(id);
    assertShop(shop);
    return getClient(db).automaticProductRuleRun.findFirst({
      where: { id, shop },
    });
  },

  async findByEditHistoryIdForShop(editHistoryId, shop, db = prisma) {
    assertId(editHistoryId, "editHistoryId");
    assertShop(shop);
    return getClient(db).automaticProductRuleRun.findFirst({
      where: { editHistoryId, shop },
      include: { automaticProductRule: true },
    });
  },

  async updatePendingToProcessingForShop(id, shop, db = prisma) {
    assertId(id);
    assertShop(shop);
    return getClient(db).automaticProductRuleRun.updateMany({
      where: { id, shop, status: "PENDING" },
      data: { status: "PROCESSING", startedAt: new Date() },
    });
  },

  async claimPendingRunForShop(
    id,
    shop,
    { processingToken, processingOwner = null } = {},
    db = prisma,
  ) {
    assertId(id);
    assertShop(shop);
    assertString(processingToken, "processingToken");
    const now = new Date();
    return getClient(db).automaticProductRuleRun.updateMany({
      where: { id, shop, status: "PENDING" },
      data: {
        status: "PROCESSING",
        startedAt: now,
        processingStartedAt: now,
        heartbeatAt: now,
        processingToken,
        processingOwner,
        lastAttemptAt: now,
        attemptCount: { increment: 1 },
      },
    });
  },

  async markPendingSkippedForShop(id, shop, data = {}, db = prisma) {
    assertId(id);
    assertShop(shop);
    return getClient(db).automaticProductRuleRun.updateMany({
      where: { id, shop, status: "PENDING" },
      data: { ...pickTransitionData(data), status: "SKIPPED", completedAt: new Date() },
    });
  },

  async markProcessingFinishedWithTokenForShop(
    { id, shop, status, processingToken, data = {} },
    db = prisma,
  ) {
    assertId(id);
    assertShop(shop);
    assertTerminalStatus(status);
    assertString(processingToken, "processingToken");
    return getClient(db).automaticProductRuleRun.updateMany({
      where: {
        id,
        shop,
        status: "PROCESSING",
        processingToken,
      },
      data: {
        ...pickTransitionData(data),
        status,
        completedAt: new Date(),
        heartbeatAt: new Date(),
      },
    });
  },

  async attachEditHistoryIdempotentForShop(
    { id, shop, editHistoryId, processingToken },
    db = prisma,
  ) {
    assertId(id);
    assertShop(shop);
    assertId(editHistoryId, "editHistoryId");
    assertString(processingToken, "processingToken");
    return getClient(db).automaticProductRuleRun.updateMany({
      where: {
        id,
        shop,
        status: "PROCESSING",
        processingToken,
        OR: [
          { editHistoryId: null },
          { editHistoryId },
        ],
      },
      data: {
        editHistoryId,
        heartbeatAt: new Date(),
      },
    });
  },

  async updateProcessingCountsForShop(
    id,
    shop,
    {
      editHistoryId = null,
      matchedCount = null,
      affectedCount = null,
      processingToken = null,
      mirrorBatchId = null,
      filterHash = null,
      targetGranularity = null,
      targetingSnapshotMeta = null,
    } = {},
    db = prisma,
  ) {
    assertId(id);
    assertShop(shop);
    const data = {};
    if (editHistoryId) data.editHistoryId = editHistoryId;
    if (matchedCount !== null && matchedCount !== undefined) data.matchedCount = matchedCount;
    if (affectedCount !== null && affectedCount !== undefined) data.affectedCount = affectedCount;
    if (mirrorBatchId) data.mirrorBatchId = mirrorBatchId;
    if (filterHash) data.filterHash = filterHash;
    if (targetGranularity) data.targetGranularity = targetGranularity;
    if (targetingSnapshotMeta && typeof targetingSnapshotMeta === "object") {
      data.targetingSnapshotMeta = targetingSnapshotMeta;
    }
    return getClient(db).automaticProductRuleRun.updateMany({
      where: {
        id,
        shop,
        status: "PROCESSING",
        ...(processingToken ? { processingToken } : {}),
      },
      data,
    });
  },

  async heartbeatProcessingRunForShop(id, shop, processingToken, db = prisma) {
    assertId(id);
    assertShop(shop);
    assertString(processingToken, "processingToken");
    return getClient(db).automaticProductRuleRun.updateMany({
      where: {
        id,
        shop,
        status: "PROCESSING",
        processingToken,
      },
      data: {
        heartbeatAt: new Date(),
      },
    });
  },

  async markStaleProcessingFailedForShop(id, shop, data = {}, db = prisma) {
    assertId(id);
    assertShop(shop);
    return getClient(db).automaticProductRuleRun.updateMany({
      where: {
        id,
        shop,
        status: "PROCESSING",
        editHistoryId: null,
      },
      data: {
        ...pickTransitionData(data),
        status: "FAILED",
        completedAt: new Date(),
      },
    });
  },

  async listByRule(automaticProductRuleId, shop, optionsOrDb = {}, maybeDb = null) {
    assertId(automaticProductRuleId, "automaticProductRuleId");
    assertShop(shop);
    const db = maybeDb || (optionsOrDb && typeof optionsOrDb === "object" && "automaticProductRuleRun" in optionsOrDb ? optionsOrDb : prisma);
    const options = maybeDb ? (optionsOrDb || {}) : (optionsOrDb && typeof optionsOrDb === "object" && !("automaticProductRuleRun" in optionsOrDb) ? optionsOrDb : {});
    const limit = clampLimit(options.limit, 50, 100);

    return getClient(db).automaticProductRuleRun.findMany({
      where: { automaticProductRuleId, shop },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    });
  },

  async groupStatusCounts(shop, ruleIds = [], db = prisma) {
    assertShop(shop);
    if (!ruleIds.length) return [];
    const uniqueRuleIds = [...new Set(ruleIds.filter(Boolean))];
    if (!uniqueRuleIds.length) return [];

    return getClient(db).automaticProductRuleRun.groupBy({
      by: ["automaticProductRuleId", "status"],
      where: {
        shop,
        automaticProductRuleId: { in: uniqueRuleIds },
      },
      _count: { _all: true },
    });
  },

  async listRunsForRules(shop, ruleIds = [], db = prisma) {
    assertShop(shop);
    if (!ruleIds.length) return [];
    const uniqueRuleIds = [...new Set(ruleIds.filter(Boolean))];
    if (!uniqueRuleIds.length) return [];

    return getClient(db).automaticProductRuleRun.findMany({
      where: {
        shop,
        automaticProductRuleId: { in: uniqueRuleIds },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  },

  async findLatestRuns(shop, ruleIds = [], db = prisma) {
    return this.listRunsForRules(shop, ruleIds, db);
  },

  async listPendingRunsWithoutHistory(limit = 100, db = prisma) {
    return getClient(db).automaticProductRuleRun.findMany({
      where: {
        status: "PENDING",
        editHistoryId: null,
        automaticProductRule: {
          isDeleted: false,
          status: "ACTIVE",
        },
      },
      select: {
        id: true,
        automaticProductRuleId: true,
        shop: true,
        executionKey: true,
        createdAt: true,
        triggerSource: true,
        mirrorBatchId: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: clampLimit(limit, 100, 500),
    });
  },

  async listStaleProcessingRunsWithoutHistory(olderThan, limit = 100, db = prisma) {
    const threshold = olderThan instanceof Date ? olderThan : new Date(olderThan);
    if (Number.isNaN(threshold.getTime())) {
      throw new Error("olderThan must be a valid Date");
    }

    return getClient(db).automaticProductRuleRun.findMany({
      where: {
        status: "PROCESSING",
        editHistoryId: null,
        startedAt: { lt: threshold },
        automaticProductRule: {
          isDeleted: false,
        },
      },
      select: {
        id: true,
        shop: true,
        automaticProductRuleId: true,
        executionKey: true,
        startedAt: true,
        mirrorBatchId: true,
      },
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      take: clampLimit(limit, 100, 500),
    });
  },

  async markQueuedForShop(id, shop, processingToken = null, db = prisma) {
    assertId(id);
    assertShop(shop);
    if (processingToken !== null && processingToken !== undefined) {
      assertString(processingToken, "processingToken");
    }
    return getClient(db).automaticProductRuleRun.updateMany({
      where: {
        id,
        shop,
        ...(processingToken ? { processingToken } : {}),
      },
      data: {
        queuedAt: new Date(),
      },
    });
  },
};
