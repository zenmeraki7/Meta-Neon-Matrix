import {
  buildAuthenticatedActor,
  handleLoggedControllerError,
  requireShopifySession,
} from "./controllerUtils.js";
import { executeProductQuery } from "../services/productService/productQueryCommandService.js";
import { getSyncStatusSummaryForShop } from "../services/syncStatusQueryService.js";
import { getPreviewFilterRegistry } from "../services/productService/productQueryCommandService.js";
import { getStoreAccessDto } from "../services/storeAccessService.js";
import {
  getOperationSummary,
  getBootstrapPlanSnapshot,
} from "../services/bootstrap/bootstrapQueryService.js";
import {
  normalizeDashboardBootstrapQuery,
  normalizeProductsBootstrapQuery,
} from "../normalizers/bootstrapQueryNormalizer.js";
import { toBootstrapSummaryDto } from "../dtos/bootstrapDto.js";
import { setPrivateNoStore } from "../http/cacheHeaders.js";

function isRecoverableProductListBootstrapError(error) {
  const message = String(error?.message || "");
  return (
    message.includes("Mirror batch unavailable") ||
    message.includes("Mirror is not safe") ||
    message.includes("Store not found") ||
    String(error?.code || "").toUpperCase() === "NOT_FOUND"
  );
}

async function resolveProductListForBootstrap({ session, actor, limit }) {
  try {
    const productQuery = await executeProductQuery({
      shop: session.shop,
      query: { limit: String(limit) },
      body: { filterParams: [] },
      actor,
    });

    return {
      products: Array.isArray(productQuery?.products) ? productQuery.products : [],
      pagination: productQuery?.pagination || null,
      count: Number(productQuery?.count || 0),
      mirrorBatchId: productQuery?.mirrorBatchId || null,
      unavailableReason: productQuery?.unavailableReason || null,
      mirrorHealth: productQuery?.mirrorHealth || null,
      error: null,
    };
  } catch (error) {
    if (!isRecoverableProductListBootstrapError(error)) {
      throw error;
    }

    return {
      products: [],
      pagination: null,
      count: 0,
      mirrorBatchId: null,
      unavailableReason: error?.message || "Product list is temporarily unavailable.",
      mirrorHealth: null,
      error: {
        code: error?.code || "PRODUCT_LIST_UNAVAILABLE",
        message: error?.message || "Product list is temporarily unavailable.",
      },
    };
  }
}

export async function getProductsBootstrap(req, res) {
  let session = null;
  try {
    session = requireShopifySession(res);
    const actor = buildAuthenticatedActor(req, session);
    setPrivateNoStore(res);
    const query = normalizeProductsBootstrapQuery(req, session);
    const { limit } = query;

    const [syncSummaryResponse, filterRegistry, productList, storeDetails, operationSummary] = await Promise.all([
      getSyncStatusSummaryForShop(session.shop),
      getPreviewFilterRegistry(),
      resolveProductListForBootstrap({ session, actor, limit }),
      getStoreAccessDto({ session }),
      getOperationSummary({ shop: session.shop }),
    ]);

    return res.status(200).json(toBootstrapSummaryDto({
      ok: true,
      shop: session.shop,
      generatedAt: new Date().toISOString(),
      storeDetails: storeDetails || null,
      syncStatus: syncSummaryResponse?.syncStatus || null,
      operationSummary: operationSummary || {
        activeCount: 0,
        latestActiveOperation: null,
      },
      filterRegistry: filterRegistry || { fields: [], versions: null },
      productList: {
        products: productList.products,
        pagination: productList.pagination,
        count: productList.count,
        mirrorBatchId: productList.mirrorBatchId,
        unavailableReason: productList.unavailableReason,
        mirrorHealth: productList.mirrorHealth,
        error: productList.error,
      },
    }));
  } catch (error) {
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "bootstrapController.getProductsBootstrap",
      fallbackCode: "BOOTSTRAP_PRODUCTS_FAILED",
    });
  }
}

export async function getDashboardBootstrap(req, res) {
  let session = null;
  try {
    session = requireShopifySession(res);
    const query = normalizeDashboardBootstrapQuery(session);
    setPrivateNoStore(res);
    const { shop } = query;

    const [storeDetails, syncSummaryResponse, operationSummary, planSnapshot] = await Promise.all([
      getStoreAccessDto({ session }),
      getSyncStatusSummaryForShop(shop),
      getOperationSummary({ shop }),
      getBootstrapPlanSnapshot(shop),
    ]);

    return res.status(200).json(toBootstrapSummaryDto({
      ok: true,
      shop,
      generatedAt: new Date().toISOString(),
      storeDetails: storeDetails || null,
      syncStatus: syncSummaryResponse?.syncStatus || null,
      operationSummary: operationSummary || {
        activeCount: 0,
        latestActiveOperation: null,
      },
      planSnapshot: planSnapshot || {
        currentPlanKey: "FREE",
        plans: [],
      },
    }));
  } catch (error) {
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "bootstrapController.getDashboardBootstrap",
      fallbackCode: "BOOTSTRAP_DASHBOARD_FAILED",
    });
  }
}
