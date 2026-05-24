import { Services } from "../services/productService/productFilterService.js";
import { successResponse, errorResponse } from "../utils/responseUtils.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { getCache, setCache } from "../utils/cacheUtils.js";
import { logApiError } from "../utils/errorLogUtils.js";
import { prisma } from "../config/database.js";
import { getStoreMirrorState } from "../services/mirrorHealthService.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";

const productService = new Services();
const MAX_LIMIT = 250;

function successOptionResponse(message, data) {
  return {
    success: true,
    message,
    count: Array.isArray(data) ? data.length : 0,
    data,
  };
}

function normalizeProductQueryRequest(query = {}, body = {}) {
  if (Object.prototype.hasOwnProperty.call(body, "queryWhere") || Object.prototype.hasOwnProperty.call(query, "queryWhere")) {
    const error = new Error("RAW_QUERY_WHERE_FORBIDDEN");
    error.code = "RAW_QUERY_WHERE_FORBIDDEN";
    throw error;
  }
  if (Object.prototype.hasOwnProperty.call(body, "mirrorBatchId") || Object.prototype.hasOwnProperty.call(query, "mirrorBatchId")) {
    const error = new Error("MIRROR_BATCH_OVERRIDE_FORBIDDEN");
    error.code = "MIRROR_BATCH_OVERRIDE_FORBIDDEN";
    throw error;
  }

  const rawLimit = Number.parseInt(String(query.limit || body.limit || "20"), 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT) : 20;

  const cursor = query.cursor == null || query.cursor === "" ? null : String(query.cursor);

  const filterParams = body.filterParams;
  if (filterParams != null && !Array.isArray(filterParams)) {
    const error = new Error("INVALID_FILTER_PARAMS");
    error.code = "INVALID_FILTER_PARAMS";
    throw error;
  }

  return {
    queryParams: {
      ...query,
      limit: String(limit),
      cursor,
    },
    filterParams: Array.isArray(filterParams) ? filterParams : [],
  };
}

export const getProductsWithQuery = async (req, res) => {
  const session = res.locals.shopify?.session;

  try {
    if (!session) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }

    if (req.query?.page && String(req.query.page) !== "1") {
      return res.status(400).json(
        errorResponse("Offset pagination is disabled for product listing. Use cursor pagination."),
      );
    }

    const normalized = normalizeProductQueryRequest(req.query, req.body);

    const result = await productService.getProductsWithFilters({
      queryParams: normalized.queryParams,
      filterParams: normalized.filterParams,
      shop: session.shop,
    });
    const mirrorState = await getStoreMirrorState(session.shop);

    if (process.env.NODE_ENV === "production") {
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await prisma.filterTrack.create({
        data: {
          shop: session.shop,
          filterParams: normalized.filterParams,
          respondProductCount: result?.count || 0,
          type: "filter",
          source: "product_query",
          expiresAt,
        },
      });
    }

    return res
      .status(200)
      .json(successResponse("Products fetched successfully", {
        ...result,
        mirrorHealth: mirrorState,
      }));
  } catch (err) {
    await logApiError({
      shop: session?.shop,
      err,
      req,
      source: "GET /api/products",
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      err,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
};

export const checkEditStatus = asyncHandler(async (req, res) => {
  const id = req.params.id;
  const session = res.locals.shopify?.session;
  if (!session?.shop) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      { code: "UNAUTHENTICATED" },
      "UNAUTHENTICATED",
    );
    return res.status(statusCode).json(body);
  }

  const history = await prisma.editHistory.findFirst({
    where: {
      id,
      shop: session.shop,
    },
    select: {
      processedCount: true,
      totalItems: true,
      durationMs: true,
    },
  });

  if (history) {
    return res.status(200).json({
      rootObjectCount: history.processedCount,
      totalItems: history.totalItems,
      duration: history.durationMs,
    });
  }

  return res.status(200).json({
    status: "not_found",
    message: "No history found",
  });
});

export const getProductTypes = async (req, res) => {
  try {
    const { search = "" } = req.query;
    const session = res.locals.shopify?.session;

    if (!session?.shop) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }

    const shop = session.shop;
    const cacheKey = `${shop}:productTypes:${String(search).toLowerCase()}`;
    const cached = await getCache(cacheKey);

    if (cached) {
      return res
        .status(200)
        .json(successOptionResponse("Product types fetched from cache", cached));
    }

    const productTypes = await productService.getDistinctProductFilterValues({
      shop,
      field: "product_type",
      search,
      take: 20,
    });

    await setCache(cacheKey, productTypes, 300);

    return res.status(200).json(
      successOptionResponse(
        "Product types fetched from product mirror",
        productTypes,
      ),
    );
  } catch (error) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
};

export const getProductFilterValues = async (req, res) => {
  const session = res.locals.shopify?.session;

  try {
    if (!session?.shop) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }

    const field = String(req.params.field || "").trim();
    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";

    const data = await productService.getDistinctProductFilterValues({
      shop: session.shop,
      field,
      search,
      take: 20,
    });

    return res
      .status(200)
      .json(successOptionResponse("Product filter values fetched successfully", data));
  } catch (error) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
};

