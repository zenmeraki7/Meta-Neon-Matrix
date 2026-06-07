import { prisma } from "../config/database.js";

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 250;
const DEFAULT_DUE_LIMIT = 100;
const MAX_DUE_LIMIT = 500;

function assertShop(shop, errorCode = "SCHEDULED_EXPORT_REQUIRES_SHOP") {
  if (!shop || typeof shop !== "string") {
    throw new Error(errorCode);
  }
}

function assertPlainCreateData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !data.shop) {
    throw new Error("SCHEDULED_EXPORT_CREATE_REQUIRES_SHOP");
  }
  return data;
}

function stripImmutableTenantFields(data = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("SCHEDULED_EXPORT_UPDATE_DATA_INVALID");
  }
  const {
    id: _id,
    shop: _shop,
    createdAt: _createdAt,
    ...safeData
  } = data;
  return safeData;
}

function clampLimit(limit, fallback, max) {
  const parsed = Number.parseInt(String(limit ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function boundedDueLimit(limit) {
  const parsed = Number.parseInt(String(limit ?? DEFAULT_DUE_LIMIT), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DUE_LIMIT;
  if (parsed > MAX_DUE_LIMIT) {
    throw new Error(`scheduled export due limit must not exceed ${MAX_DUE_LIMIT}`);
  }
  return parsed;
}

export const scheduledExportRepository = {
  async create(data, db = prisma) {
    return db.scheduledExport.create({ data: assertPlainCreateData(data) });
  },

  async findById(id, db = prisma) {
    throw new Error("scheduledExportRepository.findById requires shop; use findByIdForShop");
  },

  async findByIdForShop(id, shop, db = prisma) {
    if (!id) {
      throw new Error("SCHEDULED_EXPORT_FIND_REQUIRES_ID");
    }
    assertShop(shop, "SCHEDULED_EXPORT_FIND_REQUIRES_SHOP");
    return db.scheduledExport.findFirst({
      where: {
        id,
        shop,
        isDeleted: false,
      },
    });
  },

  async listByShop(shop, options = {}, db = prisma) {
    assertShop(shop, "SCHEDULED_EXPORT_LIST_REQUIRES_SHOP");
    const limit = clampLimit(options.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const cursorId = typeof options.cursorId === "string" ? options.cursorId.trim() : "";

    return db.scheduledExport.findMany({
      where: {
        shop,
        isDeleted: false,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
  },

  async updateByIdForShop({ id, shop, data }, db = prisma) {
    const result = await db.scheduledExport.updateMany({
      where: { id, shop },
      data: stripImmutableTenantFields(data),
    });
    return result;
  },

  async findDueScheduledExportIds(now, limit = 100, db = prisma) {
    throw new Error("findDueScheduledExportIds requires shop; use findDueScheduledExportIdsForShop");
  },

  async findDueScheduledExportIdsForShop(shop, now, limit = 100, db = prisma) {
    assertShop(shop, "findDueScheduledExportIdsForShop requires shop");
    // Scheduler path is intentionally shop-scoped; callers iterate shops and call this per tenant.
    return db.scheduledExport.findMany({
      where: {
        shop,
        isDeleted: false,
        status: "ACTIVE",
        nextRunAt: {
          lte: now,
        },
      },
      select: {
        id: true,
      },
      orderBy: [{ nextRunAt: "asc" }, { createdAt: "asc" }],
      take: boundedDueLimit(limit),
    });
  },
};
