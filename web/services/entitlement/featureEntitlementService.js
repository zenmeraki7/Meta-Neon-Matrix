import { loadAuthoritativeSubscriptionForShop } from "../subscriptionAuthorityService.js";

const FEATURE_FLAGS = Object.freeze({
  IMPORT_CSV: {
    env: "REQUIRE_PAID_PLAN_FOR_IMPORT",
    defaultRequirePaid: true,
  },
  PRODUCT_SYNC: {
    env: "REQUIRE_PAID_PLAN_FOR_PRODUCT_SYNC",
    defaultRequirePaid: false,
  },
});

function isActivePaidSubscription(subscription = {}) {
  if (subscription?.isCreditUser === true) return true;

  const planKey = String(subscription?.planKey || "FREE").toUpperCase();
  const status = String(subscription?.status || "").toUpperCase();
  if (planKey === "FREE") return false;
  return status === "ACTIVE" || status === "PENDING";
}

function resolveRequirePaid(feature) {
  const config = FEATURE_FLAGS[feature];
  if (!config) return false;

  const raw = process.env[config.env];
  if (raw == null || raw === "") return config.defaultRequirePaid;

  const normalized = String(raw).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export async function assertFeatureEntitlement({
  shop,
  feature,
  subscription = null,
}) {
  if (!shop) {
    const error = new Error("SHOP_REQUIRED");
    error.code = "VALIDATION_FAILED";
    throw error;
  }

  const requirePaid = resolveRequirePaid(feature);
  if (!requirePaid) {
    return subscription || loadAuthoritativeSubscriptionForShop(shop);
  }

  const authoritative = subscription || await loadAuthoritativeSubscriptionForShop(shop);
  if (!isActivePaidSubscription(authoritative)) {
    const error = new Error(`${feature}_PAID_PLAN_REQUIRED`);
    error.code = "FORBIDDEN";
    throw error;
  }

  return authoritative;
}

