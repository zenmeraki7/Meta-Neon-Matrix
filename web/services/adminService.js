// services/AdminService.js
// ❌ Old Mongoose imports – remove these:
// import Store from "../schema/Store.js";
// import EditHistory from "../schema/editHistorySchema.js";
// import SyncHistory from "../schema/syncHistory.js";

// ✅ Prisma
import { db } from "../repositories/repositoryDb.js";
import { BulkEditRecoveryService } from "./bulkEdit/BulkEditRecoveryService.js";
import {
  buildIdempotencyRequestHash,
  IdempotencyStoreService,
} from "./idempotency/IdempotencyStoreService.js";


class AdminService {
  constructor() {
    this.createBulkEditRecoveryService = () => new BulkEditRecoveryService();
  }

  setBulkEditRecoveryServiceFactory(factory) {
    this.createBulkEditRecoveryService =
      typeof factory === "function"
        ? factory
        : () => new BulkEditRecoveryService();
  }

  decodeCursor(cursor) {
    if (!cursor) return null;
    try {
      return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    } catch (_error) {
      return null;
    }
  }

  encodeCursor(payload) {
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  }

  async getCompletedEditHistorySummary() {
    const groups = await db.editHistory.groupBy({
      by: ["shop"],
      where: {
        status: "completed",
      },
      _count: {
        _all: true,
      },
      _max: {
        completedAt: true,
      },
    });

    const shops = groups.map((g) => g.shop).filter(Boolean);
    const stores = shops.length
      ? await db.store.findMany({
          where: { shopUrl: { in: shops } },
          select: {
            shopUrl: true,
            isUnInstalled: true,
          },
        })
      : [];

    const storeMap = new Map(stores.map((s) => [s.shopUrl, s.isUnInstalled]));

    const rawSummaries = groups.map((g) => {
      const shop = g.shop;
      const completedEdits = g._count._all;
      const lastEditAt = g._max.completedAt ?? null;
      const isUnInstalled = storeMap.get(shop) ?? null;

      return {
        shop,
        completedEdits,
        isUnInstalled,
        lastEditAt,
      };
    });

    rawSummaries.sort((a, b) => {
      const aTime = a.lastEditAt ? a.lastEditAt.getTime() : 0;
      const bTime = b.lastEditAt ? b.lastEditAt.getTime() : 0;
      return bTime - aTime;
    });

    const data = rawSummaries.map((item) => ({
      ...item,
      lastEditAt: item.lastEditAt
        ? new Date(item.lastEditAt).toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
          })
        : null,
    }));

    return {
      count: data.length,
      data,
    };
  }

  async recoverStuckBulkEditOperation({
    historyId,
    mode = "auto",
    reason,
    idempotencyKey,
    actorId = null,
    actorEmail = null,
  }) {
    const normalizedHistoryId = String(historyId || "").trim();
    const normalizedMode = String(mode || "auto").toLowerCase();
    const normalizedReason = String(reason || "").trim();
    const normalizedIdempotencyKey = String(idempotencyKey || "").trim();
    const normalizedActorId = String(actorId || "").trim() || null;
    const normalizedActorEmail = String(actorEmail || "").trim() || null;

    if (!normalizedHistoryId || !normalizedReason) {
      const error = new Error("VALIDATION_FAILED");
      error.code = "VALIDATION_FAILED";
      throw error;
    }

    if (!normalizedIdempotencyKey) {
      const error = new Error("IDEMPOTENCY_KEY_REQUIRED");
      error.code = "IDEMPOTENCY_KEY_REQUIRED";
      throw error;
    }

    const history = await db.editHistory.findUnique({
      where: { id: normalizedHistoryId },
      select: { shop: true },
    });

    const shop = String(history?.shop || "").trim();
    if (!shop) {
      const error = new Error("NOT_FOUND");
      error.code = "NOT_FOUND";
      throw error;
    }

    const idempotencyStore = new IdempotencyStoreService(db);
    const requestHash = buildIdempotencyRequestHash({
      historyId: normalizedHistoryId,
      shop,
      mode: normalizedMode,
      reason: normalizedReason,
      actorId: normalizedActorId || "",
      actorEmail: normalizedActorEmail || "",
    });
    const begin = await idempotencyStore.begin({
      shop,
      scope: "BULK_EDIT_RECOVERY_API",
      key: normalizedIdempotencyKey,
      requestHash,
    });

    if (begin.mode === "replay" && begin.response) {
      return begin.response;
    }

    const recoveryService = this.createBulkEditRecoveryService();
    const result = await recoveryService.recoverStuckState({
      historyId: normalizedHistoryId,
      shop,
      mode: normalizedMode,
      reason: normalizedReason,
      actor: {
        actorType: "ADMIN_RECOVERY",
        actorId: normalizedActorId,
        actorEmail: normalizedActorEmail,
      },
    });

    const response = { success: true, data: result };
    await idempotencyStore.complete({
      recordId: begin.recordId,
      response,
    });

    return response;
  }
  // ==================== STORE ANALYTICS ====================

  async getStoreStats() {
    const [totalStores, installedStores, uninstalledStores] =
      await Promise.all([
        db.store.count(),
        db.store.count({
          where: { isUnInstalled: false },
        }),
        db.store.count({
          where: { isUnInstalled: true },
        }),
      ]);

    return {
      totalStores,
      installedStores,
      uninstalledStores,
      installRate:
        totalStores > 0
          ? ((installedStores / totalStores) * 100).toFixed(2)
          : 0,
    };
  }

  async getAllStores({ cursor = null, limit = 20, status = "all", search = "" }) {
    const limitNum = Math.max(1, Number(limit) || 20);

    const where = {};

    // Filter by installation status
    if (status === "installed") {
      where.isUnInstalled = false;
    } else if (status === "uninstalled") {
      where.isUnInstalled = true;
    }

    // Search by shop URL or email
    if (search && search.trim()) {
      where.OR = [
        {
          shopUrl: {
            contains: search,
            mode: "insensitive",
          },
        },
        {
          shopEmail: {
            contains: search,
            mode: "insensitive",
          },
        },
      ];
    }

    const cursorPayload = this.decodeCursor(cursor);
    const cursorFilter = cursorPayload?.createdAt && cursorPayload?.id
      ? {
          OR: [
            { createdAt: { lt: new Date(cursorPayload.createdAt) } },
            { AND: [{ createdAt: new Date(cursorPayload.createdAt) }, { id: { lt: cursorPayload.id } }] },
          ],
        }
      : null;

    const [rows, total] = await Promise.all([
      db.store.findMany({
        where: {
          AND: [where, ...(cursorFilter ? [cursorFilter] : [])],
        },
        orderBy: { createdAt: "desc" },
        take: limitNum + 1,
      }),
      db.store.count({ where }),
    ]);

    const hasNextPage = rows.length > limitNum;
    const stores = hasNextPage ? rows.slice(0, limitNum) : rows;
    const last = stores[stores.length - 1] || null;
    const nextCursor = last
      ? this.encodeCursor({ id: last.id, createdAt: new Date(last.createdAt).toISOString() })
      : null;

    return {
      stores,
      pagination: {
        hasNextPage,
        nextCursor,
        totalItems: total,
        itemsPerPage: limitNum,
      },
    };
  }

  async getStoreDetails(shopUrl) {
    const store = await db.store.findUnique({
      where: { shopUrl },
    });

    if (!store) {
      throw new Error("Store not found");
    }

    const whereShop = { shop: shopUrl };

    const [editHistoryCount, syncHistoryCount, lastEdit, lastSync] =
      await Promise.all([
        db.editHistory.count({ where: whereShop }),
        db.syncHistory.count({ where: whereShop }),
        db.editHistory.findFirst({
          where: whereShop,
          orderBy: { editTime: "desc" },
        }),
        db.syncHistory.findFirst({
          where: whereShop,
          orderBy: { createdAt: "desc" },
        }),
      ]);

    return {
      store,
      stats: {
        totalEdits: editHistoryCount,
        totalSyncs: syncHistoryCount,
        lastEditDate: lastEdit?.editTime || null,
        lastSyncDate: lastSync?.createdAt || null,
      },
    };
  }

  // ==================== EDIT HISTORY ANALYTICS ====================

  async getEditHistoryStats(shopUrl = null) {
    const where = shopUrl ? { shop: shopUrl } : {};

    const [statusGroups, typeGroups, totalRecords] = await Promise.all([
      db.editHistory.groupBy({
        by: ["statusNormalized"],
        _count: { _all: true },
        where,
      }),
      db.editHistory.groupBy({
        by: ["type"],
        _count: { _all: true },
        where,
      }),
      db.editHistory.count({ where }),
    ]);

    // Format status counts
    const statusMap = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      scheduled: 0,
      "undo pending": 0,
      "undo processing": 0,
      "undo completed": 0,
      partial: 0,
      unknown: 0,
    };

    statusGroups.forEach((g) => {
      const key = (g.statusNormalized || "").toLowerCase().replace(/_/g, " ");
      if (key in statusMap) {
        statusMap[key] = g._count._all;
      }
    });

    // Format type counts
    const typeMap = {
      "Manual edit": 0,
      "Scheduled edit": 0,
      "Recurring edit": 0,
    };

    typeGroups.forEach((g) => {
      const key = g.type || "";
      if (key in typeMap) {
        typeMap[key] = g._count._all;
      }
    });

    return {
      total: totalRecords,
      byStatus: statusMap,
      byType: typeMap,
      successRate:
        totalRecords > 0
          ? ((statusMap.completed / totalRecords) * 100).toFixed(2)
          : 0,
    };
  }

  async getEditHistoryList({
    cursor = null,
    limit = 20,
    status = "all",
    type = "all",
    shopUrl = null,
    sortBy = "editTime",
    sortOrder = "desc",
  }) {
    const limitNum = Math.max(1, Number(limit) || 20);

    const where = {};
    if (shopUrl) where.shop = shopUrl;
    if (status !== "all") {
      where.statusNormalized = String(status).toUpperCase().replace(/\s+/g, "_");
    }
    if (type !== "all") where.type = type;

    // Whitelist sortable fields
    const sortFieldMap = {
      editTime: "editTime",
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    };
    const sortField = sortFieldMap[sortBy] || "editTime";
    const direction = sortOrder === "asc" ? "asc" : "desc";

    const cursorPayload = this.decodeCursor(cursor);
    const cursorFilter = cursorPayload?.sortValue && cursorPayload?.id
      ? {
          OR: [
            { [sortField]: { [direction === "asc" ? "gt" : "lt"]: new Date(cursorPayload.sortValue) } },
            { AND: [{ [sortField]: new Date(cursorPayload.sortValue) }, { id: { [direction === "asc" ? "gt" : "lt"]: cursorPayload.id } }] },
          ],
        }
      : null;

    const [rows, total] = await Promise.all([
      db.editHistory.findMany({
        where: {
          AND: [where, ...(cursorFilter ? [cursorFilter] : [])],
        },
        orderBy: [{ [sortField]: direction }, { id: direction }],
        take: limitNum + 1,
      }),
      db.editHistory.count({ where }),
    ]);

    const hasNextPage = rows.length > limitNum;
    const editHistories = hasNextPage ? rows.slice(0, limitNum) : rows;
    const last = editHistories[editHistories.length - 1] || null;
    const nextCursor = last
      ? this.encodeCursor({
          id: last.id,
          sortValue: last[sortField] ? new Date(last[sortField]).toISOString() : null,
        })
      : null;

    return {
      editHistories,
      pagination: {
        hasNextPage,
        nextCursor,
        totalItems: total,
        itemsPerPage: limitNum,
      },
    };
  }

  async getFailedEdits({ cursor = null, limit = 20, shopUrl = null }) {
    const limitNum = Math.max(1, Number(limit) || 20);

    const where = { statusNormalized: "FAILED" };
    if (shopUrl) where.shop = shopUrl;

    const cursorPayload = this.decodeCursor(cursor);
    const cursorFilter = cursorPayload?.editTime && cursorPayload?.id
      ? {
          OR: [
            { editTime: { lt: new Date(cursorPayload.editTime) } },
            { AND: [{ editTime: new Date(cursorPayload.editTime) }, { id: { lt: cursorPayload.id } }] },
          ],
        }
      : null;

    const [rows, total] = await Promise.all([
      db.editHistory.findMany({
        where: {
          AND: [where, ...(cursorFilter ? [cursorFilter] : [])],
        },
        orderBy: [{ editTime: "desc" }, { id: "desc" }],
        take: limitNum + 1,
      }),
      db.editHistory.count({ where }),
    ]);
    const hasNextPage = rows.length > limitNum;
    const failedEdits = hasNextPage ? rows.slice(0, limitNum) : rows;
    const last = failedEdits[failedEdits.length - 1] || null;
    const nextCursor = last
      ? this.encodeCursor({ id: last.id, editTime: last.editTime ? new Date(last.editTime).toISOString() : null })
      : null;

    // Group error codes in JS (error is Json[] in Prisma)
    const failedForGrouping = await db.editHistory.findMany({
      where,
      select: {
        error: true,
        shop: true,
      },
      // optional: safety cap so we don't scan millions of rows for admin analytics
      take: 1000,
    });

    const errorGroupsMap = new Map();

    for (const rec of failedForGrouping) {
      const errors = Array.isArray(rec.error) ? rec.error : [];
      for (const e of errors) {
        if (!e) continue;
        const code = e.code || "UNKNOWN";
        let group = errorGroupsMap.get(code);
        if (!group) {
          group = {
            errorCode: code,
            count: 0,
            samples: [],
          };
          errorGroupsMap.set(code, group);
        }
        group.count += 1;
        if (group.samples.length < 3) {
          group.samples.push({
            message: e.message,
            shop: rec.shop,
          });
        }
      }
    }

    const errorGroups = Array.from(errorGroupsMap.values()).sort(
      (a, b) => b.count - a.count,
    );

    return {
      failedEdits,
      errorGroups,
      pagination: {
        hasNextPage,
        nextCursor,
        totalItems: total,
        itemsPerPage: limitNum,
      },
    };
  }

  // ==================== SYNC HISTORY ANALYTICS ====================

  async getSyncHistoryStats(shopUrl = null) {
    const where = shopUrl ? { shop: shopUrl } : {};

    const [statusGroups, operationGroups, totalRecords, avgAgg] =
      await Promise.all([
        db.syncHistory.groupBy({
          by: ["status"],
          _count: { _all: true },
          where,
        }),
        db.syncHistory.groupBy({
          by: ["operationType"],
          _count: { _all: true },
          where,
        }),
        db.syncHistory.count({ where }),
        db.syncHistory.aggregate({
          _avg: { duration: true },
          where: { ...where, status: "completed" },
        }),
      ]);

    const statusMap = {
      completed: 0,
      processing: 0,
      failed: 0,
    };

    statusGroups.forEach((g) => {
      const key = g.status; // SyncStatus enum
      if (key in statusMap) {
        statusMap[key] = g._count._all;
      }
    });

    // In Prisma enum we have: Collection, ProductType, Product
    // Old analytics used label "Product Type" with a space
    const operationMap = {
      Collection: 0,
      "Product Type": 0,
      Product: 0,
    };

    operationGroups.forEach((g) => {
      const raw = g.operationType;
      if (!raw) return;
      const label = raw === "ProductType" ? "Product Type" : raw;
      if (label in operationMap) {
        operationMap[label] = g._count._all;
      }
    });

    const averageDuration = avgAgg._avg.duration || 0;

    return {
      total: totalRecords,
      byStatus: statusMap,
      byOperationType: operationMap,
      averageDuration,
      successRate:
        totalRecords > 0
          ? ((statusMap.completed / totalRecords) * 100).toFixed(2)
          : 0,
    };
  }

  async getSyncHistoryList({
    cursor = null,
    limit = 20,
    status = "all",
    operationType = "all",
    shopUrl = null,
  }) {
    const limitNum = Math.max(1, Number(limit) || 20);

    const where = {};
    if (shopUrl) where.shop = shopUrl;
    if (status !== "all") where.status = status;

    if (operationType !== "all") {
      // API uses "Product Type" but DB uses enum ProductType
      where.operationType =
        operationType === "Product Type" ? "ProductType" : operationType;
    }

    const cursorPayload = this.decodeCursor(cursor);
    const cursorFilter = cursorPayload?.createdAt && cursorPayload?.id
      ? {
          OR: [
            { createdAt: { lt: new Date(cursorPayload.createdAt) } },
            { AND: [{ createdAt: new Date(cursorPayload.createdAt) }, { id: { lt: cursorPayload.id } }] },
          ],
        }
      : null;

    const [rows, total] = await Promise.all([
      db.syncHistory.findMany({
        where: {
          AND: [where, ...(cursorFilter ? [cursorFilter] : [])],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limitNum + 1,
      }),
      db.syncHistory.count({ where }),
    ]);
    const hasNextPage = rows.length > limitNum;
    const syncHistories = hasNextPage ? rows.slice(0, limitNum) : rows;
    const last = syncHistories[syncHistories.length - 1] || null;
    const nextCursor = last
      ? this.encodeCursor({ id: last.id, createdAt: new Date(last.createdAt).toISOString() })
      : null;

    return {
      syncHistories,
      pagination: {
        hasNextPage,
        nextCursor,
        totalItems: total,
        itemsPerPage: limitNum,
      },
    };
  }

  // ==================== DASHBOARD OVERVIEW ====================

  async getDashboardOverview() {
    const [storeStats, editStats, syncStats, recentActivity] =
      await Promise.all([
        this.getStoreStats(),
        this.getEditHistoryStats(),
        this.getSyncHistoryStats(),
        this.getRecentActivity(),
      ]);

    return {
      stores: storeStats,
      edits: editStats,
      syncs: syncStats,
      recentActivity,
    };
  }

  async getRecentActivity(limit = 10) {
    const limitNum = Math.max(1, Number(limit) || 10);

    const [recentEdits, recentSyncs, recentInstalls, recentUninstalls] =
      await Promise.all([
        db.editHistory.findMany({
          orderBy: { editTime: "desc" },
          take: limitNum,
          select: {
            shop: true,
            statusNormalized: true,
            type: true,
            editTime: true,
            // There is no top-level "field" column in schema,
            // you can later derive it from "rules" Json if needed.
          },
        }),
        db.syncHistory.findMany({
          orderBy: { createdAt: "desc" },
          take: limitNum,
          select: {
            shop: true,
            status: true,
            operationType: true,
            createdAt: true,
          },
        }),
        db.store.findMany({
          where: { isUnInstalled: false },
          orderBy: { installedAt: "desc" },
          take: limitNum,
          select: {
            shopUrl: true,
            installedAt: true,
          },
        }),
        db.store.findMany({
          where: { isUnInstalled: true },
          orderBy: { unInstalledAt: "desc" },
          take: limitNum,
          select: {
            shopUrl: true,
            unInstalledAt: true,
          },
        }),
      ]);

    return {
      recentEdits,
      recentSyncs,
      recentInstalls,
      recentUninstalls,
    };
  }
}

export default new AdminService();

