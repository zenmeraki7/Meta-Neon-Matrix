import { ShopifyBillingService } from "../services/subscription/ShopifyBillingService.js";
import { resolveBillingPlan } from "../services/billingPlanRegistry.js";
import {
  createMockBillingSubscription,
  isMockBillingEnabled,
} from "../services/billingModeService.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";
import logger from "../utils/loggerUtils.js";
import { db } from "../repositories/repositoryDb.js";
import { resolveBillingStateFromActiveSubscriptions } from "../services/subscriptionAuthorityService.js";
import { applyBillingReconciliation } from "../services/billingReconciliationService.js";

function buildControllerError(code, message = code, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  error.expose = true;
  return error;
}

function getAppBaseUrl(req) {
  const configured =
    process.env.SHOPIFY_APP_URL ||
    process.env.HOST ||
    `${req.protocol}://${req.get("host")}`;
  const base = String(configured || "").replace(/\/$/, "");
  return base.startsWith("http") ? base : `https://${base}`;
}

function buildBillingReturnUrl(req, session) {
  const url = new URL("/pricing", getAppBaseUrl(req));
  if (session?.shop) {
    url.searchParams.set("shop", session.shop);
  }
  return url.toString();
}

function toDateOrNull(value) {
  return value ? new Date(value) : null;
}

function resolvePlanFromSubscriptionName(name) {
  const raw = String(name || "").trim();
  if (!raw) return null;
  return resolveBillingPlan(raw) || resolveBillingPlan(raw.replace(/\s+Monthly$/i, ""));
}

async function savePendingBillingApproval({ shop, plan, payload }) {
  const subscriptionId = payload?.appSubscription?.id || null;
  if (!subscriptionId) {
    return;
  }

  await db.subscription.upsert({
    where: { shop },
    create: {
      shop,
      status: "PENDING",
      planKey: "FREE",
      planName: "Free Plan",
      pendingSubscriptionId: subscriptionId,
      pendingPlanKey: plan.planKey,
      pendingPlanName: plan.name,
    },
    update: {
      pendingSubscriptionId: subscriptionId,
      pendingPlanKey: plan.planKey,
      pendingPlanName: plan.name,
    },
  });
}

export async function subscribeBillingController(req, res) {
  try {
    const session = res.locals.shopify?.session;
    if (!session?.shop) {
      throw buildControllerError("AUTH_REQUIRED", "Authentication required.");
    }

    const plan = resolveBillingPlan(req.body?.plan || req.body?.planKey);
    if (!plan) {
      throw buildControllerError("INVALID_BILLING_PLAN", "Invalid billing plan.", {
        allowedPlans: ["basic", "advanced", "pro"],
      });
    }

    logger.info("Billing subscription requested", {
      shop: session.shop,
      plan: plan.slug,
      planKey: plan.planKey,
      billingProvider: isMockBillingEnabled() ? "MOCK" : "SHOPIFY",
    });

    if (isMockBillingEnabled()) {
      const mockSubscription = await createMockBillingSubscription({
        shop: session.shop,
        plan,
      });

      return res.status(200).json({
        ok: true,
        success: true,
        mock: true,
        billingProvider: "MOCK",
        confirmationUrl: null,
        plan: plan.slug,
        planKey: plan.planKey,
        subscriptionId: mockSubscription.subscriptionId,
        currentPeriodEnd: mockSubscription.currentPeriodEnd.toISOString(),
        message: "Mock billing upgrade activated for local development.",
      });
    }

    const billingService = new ShopifyBillingService(session);
    const returnUrl = buildBillingReturnUrl(req, session);
    const payload = await billingService.createSubscription({
      name: plan.name,
      returnUrl,
      trialDays: plan.trialDays,
      price: plan.price,
    });

    if (!payload?.confirmationUrl) {
      throw buildControllerError(
        "BILLING_CONFIRMATION_URL_MISSING",
        "Billing confirmation URL was not returned by Shopify.",
      );
    }

    await savePendingBillingApproval({
      shop: session.shop,
      plan,
      payload,
    });

    logger.info("Billing approval pending", {
      shop: session.shop,
      plan: plan.slug,
      planKey: plan.planKey,
      subscriptionId: payload?.appSubscription?.id || null,
      returnUrl,
    });

    return res.status(200).json({
      ok: true,
      success: true,
      confirmationUrl: payload.confirmationUrl,
      plan: plan.slug,
      planKey: plan.planKey,
    });
  } catch (error) {
    logger.error("Billing subscription failed", {
      shop: res.locals.shopify?.session?.shop || null,
      plan: req.body?.plan || req.body?.planKey || null,
      code: error?.code || null,
      message: error?.message || String(error),
    });

    const fallbackCode = error?.expose === true && error?.code
      ? error.code
      : "INTERNAL_ERROR";
    const { statusCode, body } = buildPublicApiErrorResponse(error, fallbackCode);
    return res.status(statusCode).json(body);
  }
}

export async function syncBillingController(_req, res) {
  try {
    const session = res.locals.shopify?.session;
    if (!session?.shop) {
      throw buildControllerError("AUTH_REQUIRED", "Authentication required.");
    }

    if (isMockBillingEnabled()) {
      return res.status(200).json({
        ok: true,
        success: true,
        mock: true,
        synced: false,
      });
    }

    const shop = session.shop;
    const billingService = new ShopifyBillingService(session);
    const activeSubscriptions = await billingService.getActiveSubscriptions();

    // Fail-closed: FROZEN/RESTRICTED entries throw BILLING_RESTRICTED.
    // Multiple ACTIVE entries throw MULTIPLE_ACTIVE_SUBSCRIPTIONS.
    // An empty list produces a FREE state — the local row will be downgraded.
    const state = resolveBillingStateFromActiveSubscriptions({
      shop,
      activeSubscriptions,
    });

    const existingRow = await db.subscription.findFirst({ where: { shop } });

    const { applied, reason } = await applyBillingReconciliation({
      shop,
      state,
      existingRow,
    });

    logger.info("Billing sync reconciliation", {
      shop,
      status: state.status,
      planKey: state.planKey,
      subscriptionId: state.subscriptionId ?? null,
      applied,
      reason,
    });

    return res.status(200).json({
      ok: true,
      success: true,
      synced: true,
      applied,
      reason,
      status: state.status,
      planKey: state.planKey,
      subscriptionId: state.subscriptionId ?? null,
    });
  } catch (error) {
    logger.error("Billing subscription sync failed", {
      shop: res.locals.shopify?.session?.shop || null,
      code: error?.code || null,
      message: error?.message || String(error),
    });

    const fallbackCode = error?.expose === true && error?.code
      ? error.code
      : "INTERNAL_ERROR";
    const { statusCode, body } = buildPublicApiErrorResponse(error, fallbackCode);
    return res.status(statusCode).json(body);
  }
}
