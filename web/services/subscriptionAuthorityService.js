import { PLANS } from "./SubscriptionService/SubscriptionService.js";
import { getStoreCreditFlagsByShop } from "../repositories/storeRepository.js";
import { findLatestSubscriptionByShop } from "../repositories/subscriptionRepository.js";
import {
  buildPlanCapabilities,
  isKnownPlanKey,
  normalizePlanKey,
} from "./entitlement/planCapabilities.js";
import { resolveBillingPlan } from "./billingPlanRegistry.js";

const RESTRICTED_STATUSES = new Set(["FROZEN", "RESTRICTED", "BILLING_RESTRICTED"]);

function buildBillingStateError(code, message = code, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details || {};
  error.expose = true;
  return error;
}

function resolvePlanLimit(planKey, status) {
  if (status !== "ACTIVE" && status !== "PENDING") {
    return 100;
  }
  if (planKey === "DEV_TEST") return Number.MAX_SAFE_INTEGER;
  if (planKey === "PRO_MONTHLY") return Number.MAX_SAFE_INTEGER;
  if (planKey === "ADVANCED_MONTHLY") return 1000;
  return 100;
}

export async function loadAuthoritativeSubscriptionForShop(shop) {
  return resolveBillingState({ shop });
}

export function resolveBillingStateFromRecord({
  shop,
  store = null,
  subscription = null,
  source = "DATABASE_SUBSCRIPTION",
}) {
  if (!shop) {
    throw new Error("shop is required");
  }

  if (store?.isCreditAvailable === true) {
    const state = {
      shop,
      planKey: "PRO_MONTHLY",
      planName: "Pro Plan (Grandfathered)",
      limit: Number.MAX_SAFE_INTEGER,
      isUnlimited: true,
      status: "ACTIVE",
      isCreditUser: true,
      subscriptionId: null,
      billingState: "ACTIVE",
      subscriptionSource: "STORE_CREDIT",
    };
    return {
      ...state,
      capabilities: buildPlanCapabilities(state),
    };
  }

  const status = String(subscription?.status || "FREE").toUpperCase();
  const planKey = normalizePlanKey(subscription?.planKey);

  if (RESTRICTED_STATUSES.has(status)) {
    throw buildBillingStateError("BILLING_RESTRICTED", "Billing is restricted for this shop.", {
      shop,
      status,
      source,
    });
  }

  if (status === "ACTIVE" && !isKnownPlanKey(planKey)) {
    throw buildBillingStateError(
      "UNKNOWN_ACTIVE_SUBSCRIPTION",
      "Shopify returned an active subscription for an unknown billing plan.",
      {
        shop,
        planKey,
        planName: subscription?.planName || null,
        source,
      },
    );
  }

  const planName = subscription?.planName || PLANS?.[planKey]?.name || "Free Plan";
  const limit = resolvePlanLimit(planKey, status);
  const state = {
    shop,
    planKey,
    planName,
    limit,
    isUnlimited: limit === Number.MAX_SAFE_INTEGER,
    status,
    isCreditUser: false,
    subscriptionId: subscription?.subscriptionId || null,
    billingState: status === "ACTIVE" ? "ACTIVE" : "FREE",
    subscriptionSource: source,
  };

  return {
    ...state,
    capabilities: buildPlanCapabilities(state),
  };
}

export function resolveBillingStateFromActiveSubscriptions({
  shop,
  store = null,
  activeSubscriptions = [],
  source = "SHOPIFY_ACTIVE_SUBSCRIPTIONS",
}) {
  const restricted = activeSubscriptions.find((subscription) =>
    RESTRICTED_STATUSES.has(String(subscription?.status || "").toUpperCase()),
  );
  if (restricted) {
    throw buildBillingStateError("BILLING_RESTRICTED", "Billing is restricted for this shop.", {
      shop,
      subscriptionId: restricted?.id || null,
      source,
    });
  }

  const active = activeSubscriptions.filter(
    (subscription) => String(subscription?.status || "").toUpperCase() === "ACTIVE",
  );

  if (active.length > 1) {
    throw buildBillingStateError(
      "MULTIPLE_ACTIVE_SUBSCRIPTIONS",
      "Multiple active subscriptions found for this shop.",
      {
        shop,
        subscriptionIds: active.map((subscription) => subscription?.id).filter(Boolean),
        source,
      },
    );
  }

  if (active.length === 0) {
    return resolveBillingStateFromRecord({ shop, store, subscription: null, source });
  }

  const activeSubscription = active[0];
  const plan = resolveBillingPlan(activeSubscription?.name);
  if (!plan) {
    throw buildBillingStateError(
      "UNKNOWN_ACTIVE_SUBSCRIPTION",
      "Shopify returned an active subscription for an unknown billing plan.",
      {
        shop,
        subscriptionName: activeSubscription?.name || null,
        subscriptionId: activeSubscription?.id || null,
        source,
      },
    );
  }

  return resolveBillingStateFromRecord({
    shop,
    store,
    subscription: {
      planKey: plan.planKey,
      planName: plan.name,
      status: "ACTIVE",
      subscriptionId: activeSubscription?.id || null,
    },
    source,
  });
}

export async function resolveBillingState({ shop }) {
  if (!shop) {
    throw new Error("shop is required");
  }

  const [store, subscription] = await Promise.all([
    getStoreCreditFlagsByShop(shop),
    findLatestSubscriptionByShop(shop),
  ]);

  return resolveBillingStateFromRecord({
    shop,
    store,
    subscription,
    source: "DATABASE_SUBSCRIPTION",
  });
}
