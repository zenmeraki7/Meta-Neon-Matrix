import {
  executeProductQuery,
  getPreviewFilterRegistry,
} from "../services/productService/productQueryCommandService.js";
import { getSyncStatusSummaryForShop } from "../services/syncStatusQueryService.js";
import { getStoreAccess } from "../services/storeAccessService.js";
import {
  getBootstrapPlanSnapshot,
  getOperationSummary,
} from "../services/bootstrap/bootstrapQueryService.js";

const RECOVERABLE_PRODUCT_LIST_BOOTSTRAP_CODES = new Set([
  "TARGETING_MIRROR_UNSAFE",
  "MIRROR_UNAVAILABLE",
  "MIRROR_UNSAFE",
  "NOT_FOUND",
]);

function isRecoverableProductListBootstrapError(error) {
  return RECOVERABLE_PRODUCT_LIST_BOOTSTRAP_CODES.has(
    String(error?.code || "").toUpperCase(),
  );
}

function toUnavailableProductList(error) {
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

function toProductListBootstrapResult(productQuery) {
  return {
    products: Array.isArray(productQuery?.products) ? productQuery.products : [],
    pagination: productQuery?.pagination || null,
    count: Number(productQuery?.count || 0),
    mirrorBatchId: productQuery?.mirrorBatchId || null,
    unavailableReason: productQuery?.unavailableReason || null,
    mirrorHealth: productQuery?.mirrorHealth || null,
    error: productQuery?.error || null,
  };
}

async function resolveProductListForBootstrap({ shop, actor, limit }) {
  try {
    const productQuery = await executeProductQuery({
      shop,
      query: { limit: String(limit) },
      body: { filterParams: [] },
      actor,
    });

    return toProductListBootstrapResult(productQuery);
  } catch (error) {
    if (!isRecoverableProductListBootstrapError(error)) {
      throw error;
    }

    return toUnavailableProductList(error);
  }
}

function resolveStoreAccessDependencies({ locals = null, storeAccessDependencies = null } = {}) {
  const dependencies = storeAccessDependencies || locals?.storeAccessDependencies || {};
  return {
    ensureStore: dependencies.ensureStore,
    readShopTimezone: dependencies.readShopTimezone,
  };
}

export async function getProductsBootstrapData({
  shop,
  actor,
  limit,
  locals,
  storeAccessDependencies,
}) {
  const storeDeps = resolveStoreAccessDependencies({ locals, storeAccessDependencies });
  const [
    syncSummaryResponse,
    filterRegistry,
    productList,
    storeDetails,
    operationSummary,
  ] = await Promise.all([
    getSyncStatusSummaryForShop(shop),
    getPreviewFilterRegistry(),
    resolveProductListForBootstrap({ shop, actor, limit }),
    getStoreAccess({ shop, ...storeDeps }),
    getOperationSummary({ shop }),
  ]);

  return {
    shop,
    storeDetails,
    syncSummaryResponse,
    operationSummary,
    filterRegistry,
    productList,
  };
}

export async function getDashboardBootstrapData({
  shop,
  locals,
  storeAccessDependencies,
}) {
  const storeDeps = resolveStoreAccessDependencies({ locals, storeAccessDependencies });
  const [
    storeDetails,
    syncSummaryResponse,
    operationSummary,
    planSnapshot,
  ] = await Promise.all([
    getStoreAccess({ shop, ...storeDeps }),
    getSyncStatusSummaryForShop(shop),
    getOperationSummary({ shop }),
    getBootstrapPlanSnapshot({ shop }),
  ]);

  return {
    shop,
    storeDetails,
    syncSummaryResponse,
    operationSummary,
    planSnapshot,
  };
}
