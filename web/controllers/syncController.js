import { Services } from "../services/productService/productFilterService.js";
import {
  getCurrentBulkOperationStatus,
} from "../utils/bulkOperationHelper.js";
import { clearKeyCaches } from "../utils/cacheUtils.js";
import { logApiError } from "../utils/errorLogUtils.js";
import { prisma } from "../config/database.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";
import {
  getSyncStatusDetailForShop,
  getSyncStatusSummaryForShop,
  getTrackedProductSyncStatus,
} from "../services/syncStatusQueryService.js";

const service = new Services();

export const syncProductData = async (req, res) => {
  const session = res.locals?.shopify?.session;

  try {
    if (!session?.shop) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }

        console.log(`[api:sync_request] shop=${session.shop} force=${req.query.force || req.body?.force}`);

    const currentBulkOperation = await getCurrentBulkOperationStatus(
      session,
      "QUERY",
    );

     if (currentBulkOperation?.status === "RUNNING") {
      console.log(`[api:sync_blocked] shop=${session.shop} reason=bulk_op_running`);
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "CONFLICT" },
        "CONFLICT",
      );
      return res.status(statusCode).json(body);
    }

    const force =
      String(req.query.force || req.body?.force || "")
        .trim()
        .toLowerCase() === "true";

    const [store, productCount, latestCompletedSync] = await Promise.all([
      prisma.store.findUnique({
        where: { shopUrl: session.shop },
        select: {
          isProductSyncing: true,
          isProductInitialySyning: true,
          shopifyBulkJobCompleted: true,
          storeTotalProducts: true,
          lastProductSyncAt: true,
          syncProgressStage: true,
        },
      }),

      prisma.product.count({
        where: { shop: session.shop },
      }),

      prisma.syncHistory.findFirst({
        where: {
          shop: session.shop,
          operationType: "Product",
          status: "completed",
        },
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          updatedAt: true,
          recordCount: true,
          syncBatchId: true,
        },
      }),
    ]);

    const alreadySynced =
      !!store &&
      store.isProductSyncing === false &&
      store.isProductInitialySyning === false &&
      store.shopifyBulkJobCompleted === true &&
      productCount > 0;

    if (alreadySynced && !force) {
      return res.status(200).json({
        message: "Products already synced. Skipping new sync.",
        skipped: true,
        forceAllowed: true,
        data: {
          productCount,
          storeTotalProducts: store.storeTotalProducts,
          lastProductSyncAt: store.lastProductSyncAt,
          lastCompletedSyncAt: latestCompletedSync?.updatedAt || null,
          lastCompletedRecordCount: latestCompletedSync?.recordCount || null,
          lastCompletedSyncBatchId: latestCompletedSync?.syncBatchId || null,
        },
      });
    }

    const result = await service.startBulkOperationToFetchProducts({
      session,
      isInitialSync: false,
    });
    console.log(`[api:sync_triggered] shop=${session.shop} bulkOperationId=${result.bulkOperationId} syncHistoryId=${result.syncHistoryId}`);

    await clearKeyCaches(`${session.shop}:sync_details`);

    return res.status(200).json({
      success: true,
      message: "Product sync started",
      skipped: false,
      forced: force,
      bulkOperationId: result.bulkOperationId,
      syncHistoryId: result.syncHistoryId,
      syncBatchId: result.syncBatchId,
    });
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "syncController.syncProductData",
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
};

export const getSyncStatus = async (req, res) => {
  const session = res.locals?.shopify?.session;

  try {
    const shop = session?.shop;

    if (!shop) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }

    const response = await getSyncStatusDetailForShop(shop);
    return res.status(200).json(response);
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "syncController.getSyncStatus",
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
};

export const getSyncStatusDetail = getSyncStatus;

export const getSyncStatusSummary = async (req, res) => {
  const session = res.locals?.shopify?.session;

  try {
    const shop = session?.shop;
    if (!shop) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }

    const response = await getSyncStatusSummaryForShop(shop);
    return res.status(200).json(response);
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "syncController.getSyncStatusSummary",
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
};

export const trackProductSync = async (req, res) => {
  let session = null;
  try {
    session = res.locals?.shopify?.session || null;
    const shop = session?.shop;

    if (!shop) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }

    const response = await getTrackedProductSyncStatus({ session, shop });
    return res.status(200).json(response);
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "syncController.trackProductSync",
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
};
