import { createRequire } from "node:module";
import { prisma } from "../config/database.js";

const require = createRequire(import.meta.url);
const prismaGenerated = require("../generated/prisma/index.js");
const {
  AutomaticProductRuleStatus,
  AutomaticProductRuleTriggerType,
} = prismaGenerated;

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

function clampLimit(limit, fallback = 50, max = 100) {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function activeWindowWhere(now) {
  return [
    {
      OR: [
        { startAt: null },
        { startAt: { lte: now } },
      ],
    },
    {
      OR: [
        { endAt: null },
        { endAt: { gte: now } },
      ],
    },
  ];
}

function resolveListByShopArgs(optionsOrDb, maybeDb) {
  if (maybeDb) {
    return {
      options: optionsOrDb || {},
      db: maybeDb,
    };
  }

  const looksLikeDbClient = optionsOrDb && typeof optionsOrDb === "object" && "automaticProductRule" in optionsOrDb;
  if (looksLikeDbClient) {
    return {
      options: {},
      db: optionsOrDb,
    };
  }

  return {
    options: optionsOrDb || {},
    db: prisma,
  };
}

function pickCreateData(data = {}) {
  return {
    shop: data.shop,
    title: data.title,
    status: data.status || AutomaticProductRuleStatus.ACTIVE,
    triggerType: data.triggerType,
    scheduleType: data.scheduleType ?? null,
    timezone: data.timezone ?? null,
    scheduleConfig: data.scheduleConfig ?? null,
    cronExpression: data.cronExpression ?? null,
    intervalMinutes: data.intervalMinutes ?? null,
    startAt: data.startAt ?? null,
    endAt: data.endAt ?? null,
    scopeType: data.scopeType,
    conditions: data.conditions,
    actions: data.actions,
    applyMode: data.applyMode,
    priority: data.priority ?? 100,
    cooldownMinutes: data.cooldownMinutes ?? null,
    maxAffectedPerRun: data.maxAffectedPerRun ?? null,
    nextRunAt: data.nextRunAt ?? null,
    filterVersion: data.filterVersion ?? 1,
    canonicalFilterKey: data.canonicalFilterKey ?? null,
    actorType: data.actorType ?? null,
    actorId: data.actorId ?? null,
    actorEmail: data.actorEmail ?? null,
    actorName: data.actorName ?? null,
    createdBy: data.createdBy ?? null,
    updatedBy: data.updatedBy ?? null,
  };
}

function pickDefinitionUpdateData(data = {}) {
  const allowedKeys = [
    "title",
    "status",
    "triggerType",
    "scheduleType",
    "timezone",
    "scheduleConfig",
    "cronExpression",
    "intervalMinutes",
    "startAt",
    "endAt",
    "scopeType",
    "conditions",
    "actions",
    "applyMode",
    "priority",
    "cooldownMinutes",
    "maxAffectedPerRun",
    "nextRunAt",
    "filterVersion",
    "canonicalFilterKey",
    "actorType",
    "actorId",
    "actorEmail",
    "actorName",
    "updatedBy",
  ];

  return allowedKeys.reduce((accumulator, key) => {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      accumulator[key] = data[key];
    }
    return accumulator;
  }, {});
}

export const automaticProductRuleRepository = {
  async createUnsafeInternal(data, db = prisma) {
    return getClient(db).automaticProductRule.create({ data });
  },

  async create(data, db = prisma) {
    return getClient(db).automaticProductRule.create({
      data: pickCreateData(data),
    });
  },

  async findByIdUnsafeInternal(id, db = prisma) {
    throw new Error("findByIdUnsafeInternal is forbidden; use findByIdForShop");
  },

  async findByIdForShop(id, shop, db = prisma) {
    assertId(id);
    assertShop(shop);
    return getClient(db).automaticProductRule.findFirst({
      where: { id, shop, isDeleted: false },
    });
  },

  async listByShop(shop, optionsOrDb = {}, maybeDb = null) {
    assertShop(shop);
    const { options, db } = resolveListByShopArgs(optionsOrDb, maybeDb);
    const limit = clampLimit(options.limit, 50, 100);
    const cursorId = typeof options.cursorId === "string" ? options.cursorId : null;

    return getClient(db).automaticProductRule.findMany({
      where: { shop, isDeleted: false },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      take: limit,
    });
  },

  async updateByIdForShop(id, shop, data, db = prisma) {
    assertId(id);
    assertShop(shop);
    return getClient(db).automaticProductRule.updateMany({
      where: {
        id,
        shop,
        isDeleted: false,
      },
      data,
    });
  },

  async updateDefinitionByIdForShop(id, shop, data, db = prisma) {
    assertId(id);
    assertShop(shop);
    return getClient(db).automaticProductRule.updateMany({
      where: {
        id,
        shop,
        isDeleted: false,
      },
      data: pickDefinitionUpdateData(data),
    });
  },

  async countActiveByShop(shop, excludeId = null, db = prisma) {
    assertShop(shop);
    if (excludeId !== null && excludeId !== undefined) {
      assertId(excludeId, "excludeId");
    }
    return getClient(db).automaticProductRule.count({
      where: {
        shop,
        isDeleted: false,
        status: AutomaticProductRuleStatus.ACTIVE,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
  },

  async findDueRuleIds(now, limit = 100, db = prisma) {
    throw new Error("findDueRuleIds is forbidden; use findDueRuleIdsForShop");
  },

  async findDueRuleIdsForShop(shop, now, limit = 100, db = prisma) {
    assertShop(shop);
    return getClient(db).automaticProductRule.findMany({
      where: {
        shop,
        isDeleted: false,
        status: AutomaticProductRuleStatus.ACTIVE,
        triggerType: {
          in: [
            AutomaticProductRuleTriggerType.SCHEDULED,
            AutomaticProductRuleTriggerType.HYBRID,
          ],
        },
        nextRunAt: { lte: now },
        AND: activeWindowWhere(now),
      },
      select: {
        id: true,
        shop: true,
        nextRunAt: true,
      },
      orderBy: [{ priority: "asc" }, { nextRunAt: "asc" }, { createdAt: "asc" }],
      take: clampLimit(limit, 100, 500),
    });
  },

  async listRunnableEventRulesByShop(shop, now = new Date(), db = prisma) {
    assertShop(shop);
    return getClient(db).automaticProductRule.findMany({
      where: {
        shop,
        isDeleted: false,
        status: AutomaticProductRuleStatus.ACTIVE,
        triggerType: {
          in: [
            AutomaticProductRuleTriggerType.EVENT,
            AutomaticProductRuleTriggerType.HYBRID,
          ],
        },
        AND: activeWindowWhere(now),
      },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    });
  },

  async listSignalEligibleByShop(shop, db = prisma) {
    assertShop(shop);
    return getClient(db).automaticProductRule.findMany({
      where: {
        shop,
        isDeleted: false,
        status: AutomaticProductRuleStatus.ACTIVE,
        triggerType: {
          in: [
            AutomaticProductRuleTriggerType.EVENT,
            AutomaticProductRuleTriggerType.HYBRID,
          ],
        },
        AND: activeWindowWhere(new Date()),
      },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    });
  },
};
