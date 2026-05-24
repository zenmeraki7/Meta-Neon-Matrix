// web/controllers/historyController.js

import { ProductExportService } from "../services/productService/productExportService.js";
import { successResponse, errorResponse } from "../utils/responseUtils.js";
import { EditHistoryService } from "../services/historyService/historyService.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { logApiError } from "../utils/errorLogUtils.js";
import { NotFoundError } from "../utils/errorUtils.js";
import { prisma } from "../config/database.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";

function toImportHistoryListDto(history) {
  return {
    id: history.id,
    status: history.status,
    fileName: history.fileName ?? null,
    createdAt: history.createdAt,
    completedAt: history.completedAt ?? null,
    totalRows: history.totalRows ?? 0,
    successCount: history.successCount ?? 0,
    failedCount: history.failedCount ?? 0,
  };
}

function toImportHistoryDetailDto(history) {
  return {
    id: history.id,
    status: history.status,
    fileName: history.fileName ?? null,
    totalRows: history.totalRows ?? 0,
    successCount: history.successCount ?? 0,
    failedCount: history.failedCount ?? 0,
    errors: Array.isArray(history.errors) ? history.errors : [],
    createdAt: history.createdAt,
    completedAt: history.completedAt ?? null,
  };
}

function toRecurringJobDto(job) {
  return {
    id: job.id,
    status: job.status,
    ruleId: job.ruleId || null,
    nextRunAt: job.nextRunAt ?? null,
    lastRunAt: job.lastRunAt ?? null,
    createdAt: job.createdAt,
  };
}

// ─────────────────────────────────────────────────────────────
// Export histories
// ─────────────────────────────────────────────────────────────

export const getAllExportHistories = asyncHandler(async (req, res) => {
  const session = res.locals.shopify.session;
  const lang = req.query.lang || "en";

  if (!session?.shop) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      { code: "UNAUTHENTICATED" },
      "UNAUTHENTICATED",
    );
    return res.status(statusCode).json(body);
  }

  const service = new ProductExportService(session);

  try {
    const result = await service.getAllExportHistories(lang);

    return res
      .status(200)
      .json(successResponse("Fetched export histories", result));
  } catch (error) {
    console.error("Error in getAllExportHistories:", error);
    await logApiError({
      shop: session.shop,
      err: error,
      req,
      source: "historyController.getAllExportHistories",
    });
    return res.status(500).json(errorResponse("Failed to fetch histories"));
  }
});

export const getExportHistoryDetails = async (req, res) => {
  const session = res.locals.shopify?.session;
  const id = req.params.id;

  try {
    if (!session?.shop) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }

    const service = new ProductExportService(session);
    const result = await service.getExportHistoryDetails(id);

    return res
      .status(200)
      .json(successResponse("Fetched history detail", result));
  } catch (err) {
    await logApiError({
      shop: session?.shop,
      err,
      req,
      source: "GET /api/export-history/:id",
    });

    return res
      .status(500)
      .json(errorResponse("Failed to fetch export history details"));
  }
};

// ─────────────────────────────────────────────────────────────
// Edit histories
// ─────────────────────────────────────────────────────────────

export const getAllEditHistories = asyncHandler(async (req, res) => {
  const session = res.locals.shopify.session;
  const { type, search, cursor, limit, lang } = req.query;

  if (!session?.shop) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      { code: "UNAUTHENTICATED" },
      "UNAUTHENTICATED",
    );
    return res.status(statusCode).json(body);
  }

  const service = new EditHistoryService(session, req.activePlan || {});

  try {
    const result = await service.getEditHistories({
      type,
      search,
      cursor: cursor || null,
      limit: limit || 10,
      lang: lang || "en",
    });

    return res.status(200).json(
      successResponse("Fetched edit histories", result.edges, {
        pageInfo: result.pageInfo,
        total: result.totalCount,
        planLimit: result.planLimit,
      }),
    );
  } catch (error) {
    console.error("Error in getAllEditHistories:", error);
    await logApiError({
      shop: session.shop,
      err: error,
      req,
      source: "historyController.getAllEditHistories",
    });
    return res.status(500).json(errorResponse("Failed to fetch histories"));
  }
});

export const getHistoryDetails = async (req, res) => {
  const session = res.locals.shopify?.session;
  const id =
    req.params?.id ||
    req.query?.id ||
    req.query?.historyId ||
    null;
  const { lang } = req.query;

  try {
    if (!session?.shop) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }

    if (!id || id === "undefined" || id === "null") {
      return res.status(400).json(errorResponse("History id is required"));
    }

    const service = new EditHistoryService(session, req.activePlan || {});
    const result = await service.getHistoryDetails(id, lang || "en");

    return res
      .status(200)
      .json(successResponse("Fetched history detail", result));
  } catch (err) {
    await logApiError({
      shop: session?.shop,
      err,
      req,
      source: "GET /api/history/:id",
    });

    if (err instanceof NotFoundError) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "NOT_FOUND" },
        "NOT_FOUND",
      );
      return res.status(statusCode).json(body);
    }

    const { statusCode, body } = buildPublicApiErrorResponse(
      err,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
};

export const getHistoryChanges = async (req, res) => {
  const session = res.locals.shopify?.session;
  const id =
    req.params?.id ||
    req.query?.id ||
    req.query?.historyId ||
    null;
  const { cursor = null, limit = 10, page } = req.query;

  try {
    if (!session?.shop) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }

    if (!id || id === "undefined" || id === "null") {
      return res.status(400).json(errorResponse("History id is required"));
    }

    if (page && String(page) !== "1") {
      return res.status(400).json(errorResponse("Offset pagination is disabled. Use cursor pagination."));
    }

    const service = new EditHistoryService(session, req.activePlan || {});
    const result = await service.getHistoryEditChanges(id, cursor, limit);

    return res
      .status(200)
      .json(successResponse("Fetched history changes", result.changes, {
        pageInfo: result.pageInfo,
        totalCount: result.totalCount,
      }));
  } catch (err) {
    await logApiError({
      shop: session?.shop,
      err,
      req,
      source: "GET /api/history/:id/changes",
    });

    if (err instanceof NotFoundError) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "NOT_FOUND" },
        "NOT_FOUND",
      );
      return res.status(statusCode).json(body);
    }

    const { statusCode, body } = buildPublicApiErrorResponse(
      err,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
};

// ─────────────────────────────────────────────────────────────
// Import histories
// ─────────────────────────────────────────────────────────────

export const getAllImportHistories = asyncHandler(async (req, res) => {
  const session = res.locals.shopify.session;

  if (!session?.shop) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      { code: "UNAUTHENTICATED" },
      "UNAUTHENTICATED",
    );
    return res.status(statusCode).json(body);
  }

  const { cursor = null, page } = req.query;
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "10", 10)));

  if (page && String(page) !== "1") {
    return res.status(400).json({
      success: false,
      message: "Offset pagination is disabled. Use cursor pagination.",
    });
  }

  let cursorFilter = {};
  if (cursor) {
    const cursorRow = await prisma.spreadsheetFile.findFirst({
      where: { id: cursor, shop: session.shop },
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
    prisma.spreadsheetFile.findMany({
      where: {
        AND: [
          { shop: session.shop },
          ...(Object.keys(cursorFilter).length ? [cursorFilter] : []),
        ],
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
    }),
    prisma.spreadsheetFile.count({
      where: { shop: session.shop },
    }),
  ]);

  const hasNextPage = rows.length > limit;
  const histories = hasNextPage ? rows.slice(0, limit) : rows;
  const endCursor = histories.length ? histories[histories.length - 1].id : null;

  return res.status(200).json({
    success: true,
    count: histories.length,
    totalCount,
    pageInfo: {
      hasNextPage,
      endCursor,
    },
    data: histories.map(toImportHistoryListDto),
  });
});

export const getImportHistoryDetails = asyncHandler(async (req, res) => {
  const session = res.locals.shopify.session;
  const { id } = req.params;

  if (!session?.shop) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      { code: "UNAUTHENTICATED" },
      "UNAUTHENTICATED",
    );
    return res.status(statusCode).json(body);
  }

  const history = await prisma.spreadsheetFile.findFirst({
    where: {
      id,
      shop: session.shop,
    },
  });

  if (!history) {
    return res.status(404).json({
      error: "Not Found",
      message: "Import history record not found",
    });
  }

  return res.status(200).json({
    success: true,
    data: toImportHistoryDetailDto(history),
  });
});

// ─────────────────────────────────────────────────────────────
// Recurring edits
// ─────────────────────────────────────────────────────────────

export const getRecurringEdits = async (req, res) => {
  try {
    const { shop } = res.locals.shopify.session;
    if (!shop) {
      return res.status(400).json({ message: "Shop is required" });
    }

    if (!prisma.recurringEdit) {
      return res.status(501).json({ message: "Recurring edit is not migrated to Prisma yet" });
    }

    const datas = await prisma.recurringEdit.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        status: true,
        frequency: true,
        dayOfMonthToRun: true,
        daysOfWeekToRun: true,
        isCurrentlyRunning: true,
        createdAt: true,
      },
    });

    return res.status(200).json({
      data: datas.map(toRecurringJobDto),
      message: "recurring edit fetched successfully",
    });
  } catch (err) {
    console.error("getRecurringEdits error:", err);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

export const getRecurringEditById = async (req, res) => {
  try {
    const { shop } = res.locals.shopify.session;
    const { id } = req.params;

    if (!prisma.recurringEdit) {
      return res.status(501).json({ message: "Recurring edit is not migrated to Prisma yet" });
    }

    const job = await prisma.recurringEdit.findFirst({
      where: {
        id,
        shop,
      },
    });

    if (!job) {
      return res.status(404).json({ message: "Recurring edit not found" });
    }

    return res
      .status(200)
      .json({ data: toRecurringJobDto(job), message: "Job fetched successfully" });
  } catch (err) {
    console.error("getRecurringEditById error:", err);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

