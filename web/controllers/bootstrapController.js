import {
  buildAuthenticatedActor,
  handleLoggedControllerError,
  requireShopifySession,
} from "./controllerUtils.js";
import { executeProductQuery } from "../services/productService/productQueryCommandService.js";
import { getSyncStatusSummaryForShop } from "../services/syncStatusQueryService.js";
import { getPreviewFilterRegistry } from "../services/productService/productQueryCommandService.js";
import { getStoreAccessDto } from "../services/storeAccessService.js";
import { prisma } from "../config/database.js";
import { getPlansArray } from "../services/SubscriptionService/SubscriptionService.js";

const ACTIVE_EXECUTION_STATES = [
  "QUEUED",
  "SCHEDULED_QUEUED",
  "TARGET_FREEZING",
  "TARGET_FROZEN",
  "PLANNED",
  "EXECUTING",
  "WAITING_FOR_SHOPIFY_SLOT",
  "VERIFYING",
  "UNDO_QUEUED",
  "UNDO_EXECUTING",
];

async function getOperationSummary(shop) {
  const [activeCount, latestActive] = await Promise.all([
    prisma.editHistory.count({
      where: {
        shop,
        executionState: {
          in: ACTIVE_EXECUTION_STATES,
        },
      },
    }),
    prisma.editHistory.findFirst({
      where: {
        shop,
        executionState: {
          in: ACTIVE_EXECUTION_STATES,
        },
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        executionState: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        processedCount: true,
        totalItems: true,
      },
    }),
  ]);

  return {
    activeCount: Number(activeCount || 0),
    latestActiveOperation: latestActive
      ? {
          id: latestActive.id,
          executionState: latestActive.executionState || null,
          status: latestActive.status || null,
          createdAt: latestActive.createdAt || null,
          updatedAt: latestActive.updatedAt || null,
          processedCount: Number(latestActive.processedCount || 0),
          totalItems: Number(latestActive.totalItems || 0),
        }
      : null,
  };
}

async function getPlanSnapshot(shop) {
  const subscription = await prisma.subscription.findFirst({
    where: { shop },
    select: { planKey: true, status: true },
  });

  const currentPlanKey =
    subscription && String(subscription.status || "").toUpperCase() === "ACTIVE"
      ? String(subscription.planKey || "FREE")
      : "FREE";

  const plans = getPlansArray().map((plan) => ({
    ...plan,
    isCurrent: plan.key === currentPlanKey,
  }));

  return {
    currentPlanKey,
    plans,
  };
}

export async function getProductsBootstrap(req, res) {
  let session = null;
  try {
    session = requireShopifySession(res);
    const actor = buildAuthenticatedActor(req, session);
    const limit = Math.min(
      50,
      Math.max(1, Number.parseInt(String(req.query.limit || "20"), 10) || 20),
    );

    const [syncSummaryResponse, filterRegistry, productQuery, storeDetails, operationSummary] = await Promise.all([
      getSyncStatusSummaryForShop(session.shop),
      getPreviewFilterRegistry(),
      executeProductQuery({
        shop: session.shop,
        query: { limit: String(limit) },
        body: { filterParams: [] },
        actor,
      }),
      getStoreAccessDto({ session }),
      getOperationSummary(session.shop),
    ]);

    return res.status(200).json({
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
        products: Array.isArray(productQuery?.products) ? productQuery.products : [],
        pagination: productQuery?.pagination || null,
        count: Number(productQuery?.count || 0),
        mirrorBatchId: productQuery?.mirrorBatchId || null,
      },
    });
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
    const shop = String(session.shop || "").trim();

    const [storeDetails, syncSummaryResponse, operationSummary, planSnapshot] = await Promise.all([
      getStoreAccessDto({ session }),
      getSyncStatusSummaryForShop(shop),
      getOperationSummary(shop),
      getPlanSnapshot(shop),
    ]);

    return res.status(200).json({
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
    });
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
