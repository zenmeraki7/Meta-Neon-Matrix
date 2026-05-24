// web/controllers/collectionController.js
import Joi from "joi";
import { getCurrentBulkOperationStatus } from "../utils/bulkOperationHelper.js";
import logger from "../utils/loggerUtils.js";
import { clearKeyCaches } from "../utils/cacheUtils.js";
import { logApiError } from "../utils/errorLogUtils.js";
import CollectionControllerService from "../services/collection/collectionService.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";

// ⛔️ REMOVE this:
// import Store from "../schema/Store.js";

// ✅ ADD Prisma
import { prisma } from "../config/database.js";

const collectionControllerService = new CollectionControllerService();


// ✅ Validate query param "search"
const getAllCollectionsQuerySchema = Joi.object({
  search: Joi.string().trim().allow("").max(100).optional(),
  isNameOnly: Joi.string().trim().allow("").max(100).optional(),
  limit: Joi.number().integer().min(1).max(50).optional(),
});

export const getAllCollection =
  (collectionService) => async (req, res, next) => {
    try {
      const { error, value } = getAllCollectionsQuerySchema.validate(req.query);
      if (error) {
        return res.status(400).json({
          error: `Invalid query: ${error.details[0].message}`,
        });
      }

      const session = res.locals?.shopify?.session;
      if (!session?.shop) {
        const { statusCode, body } = buildPublicApiErrorResponse(
          { code: "UNAUTHENTICATED" },
          "UNAUTHENTICATED",
        );
        return res.status(statusCode).json(body);
      }

      const searchText = value.search?.trim() || "";

      const result = await collectionService.fetchCollections(
        session,
        searchText,
      );

      const data = Array.isArray(result?.data)
        ? result.data
            .filter((item) => item?.title)
            .map((item) => ({
              label: item.title,
              value: item.shopifyId || item.id,
              title: item.title,
              id: item.shopifyId || item.id,
            }))
        : [];

      return res.status(200).json({
        success: true,
        count: data.length,
        message: result?.message || "Collections fetched successfully",
        data,
      });
    } catch (error) {
      logger.error("Failed to get collections", { error: error.message });
      const { statusCode, body } = buildPublicApiErrorResponse(
        error,
        "INTERNAL_ERROR",
      );
      return res.status(statusCode).json(body);
    }
  };

export const getCollectionsFromShopify = async (req, res) => {
  const session = res.locals?.shopify?.session;
  try {
    if (!session?.shop) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }
    const { error, value } = getAllCollectionsQuerySchema.validate(req.query);
    if (error) {
      return res.status(400).json({
        error: `Invalid query: ${error.details[0].message}`,
      });
    }

    const searchText = value.search?.trim() || "";
    const collections = await collectionControllerService.fetchFromShopify({
      session,
      search: searchText,
      limit: value.limit || 20,
    });

    return res.status(200).json({
      success: true,
      count: collections.length,
      data: collections,
    });
  } catch (error) {
    logger.error("Failed to get collections", {
      error: error.message,
    });
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "collectionController.getCollectionsFromShopify",
    });
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
};

export const clearCollections =
  (collectionService) => async (req, res, next) => {
    try {
      const session = res.locals?.shopify?.session;
      if (!session?.shop) {
        const { statusCode, body } = buildPublicApiErrorResponse(
          { code: "UNAUTHENTICATED" },
          "UNAUTHENTICATED",
        );
        return res.status(statusCode).json(body);
      }

      const { status } = await getCurrentBulkOperationStatus(session, "QUERY");
      if (status === "RUNNING") {
        return res.status(400).json({
          message: "Another operation is running in background",
        });
      }

      const result = await collectionService.clearCollections(session);

      // 🔁 Mongo → Prisma: update flattened sync fields
      const store = await prisma.store.update({
        where: { shopUrl: session.shop },
        data: {
          isCollectionSyncing: true,
          lastCollectionSyncAt: new Date(),
        },
      });

      if (!store) {
        // In practice prisma.update would throw if not found
        return res.status(404).json({
          error: "Store not found",
        });
      }

      // 🧹 Clear cached sync details after updating DB
      await clearKeyCaches(`${session.shop}:sync_details`);

      return res.status(200).json({
        message: "Collections refreshed successfully",
        result,
      });
    } catch (error) {
      logger.error("Failed to clear collections", { error: error.message });
      const { statusCode, body } = buildPublicApiErrorResponse(
        error,
        "INTERNAL_ERROR",
      );
      return res.status(statusCode).json(body);
    }
  };

