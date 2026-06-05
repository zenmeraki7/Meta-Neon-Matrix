import {
  getOperationSummaryByShop,
  getSubscriptionPlanSnapshotByShop,
} from "../../repositories/bootstrapRepository.js";
import { getPlansArray } from "../SubscriptionService/SubscriptionService.js";
import { requireShopScope } from "../../utils/shopScope.js";

const PLAN_RESPONSE_FIELDS = [
  "key",
  "name",
  "price",
  "compareAtPrice",
  "trialDays",
  "isFree",
  "description",
  "highlight",
  "popular",
  "features",
  "buttonText",
  "buttonVariant",
];

const PLAN_STATUSES_USING_STORED_PLAN = new Set([
  "ACTIVE",
  "PENDING",
  "FROZEN",
]);

const PLAN_STATUSES_FALLING_BACK_TO_FREE = new Set([
  "CANCELLED",
  "CANCELED",
  "DECLINED",
  "EXPIRED",
  "INACTIVE",
]);

const CACHED_PLAN_CATALOG = Object.freeze(
  getPlansArray().map((plan) => sanitizePlanForBootstrap(plan)),
);

function sanitizePlanForBootstrap(plan = {}) {
  return PLAN_RESPONSE_FIELDS.reduce((acc, field) => {
    if (!Object.prototype.hasOwnProperty.call(plan, field)) return acc;
    const value = plan[field];
    acc[field] = Array.isArray(value) ? [...value] : value;
    return acc;
  }, {});
}

function resolvePlanKey(subscription) {
  if (!subscription) return "FREE";
  const status = String(subscription.status || "").toUpperCase();
  if (PLAN_STATUSES_USING_STORED_PLAN.has(status)) {
    return String(subscription.planKey || "FREE");
  }
  if (PLAN_STATUSES_FALLING_BACK_TO_FREE.has(status)) {
    return "FREE";
  }
  return "FREE";
}

function buildPlanSnapshot(subscription = null, unavailable = false) {
  const currentPlanKey = resolvePlanKey(subscription);
  return {
    currentPlanKey,
    subscriptionStatus: subscription?.status ? String(subscription.status) : null,
    unavailable,
    plans: CACHED_PLAN_CATALOG.map((plan) => {
      const exposedPlan = sanitizePlanForBootstrap(plan);
      return {
        ...exposedPlan,
        features: Array.isArray(exposedPlan.features) ? [...exposedPlan.features] : [],
        isCurrent: exposedPlan.key === currentPlanKey,
      };
    }),
  };
}

export async function getOperationSummary(command = {}) {
  const shop = requireShopScope(command?.shop);
  try {
    return await getOperationSummaryByShop(shop);
  } catch (error) {
    return {
      activeCount: 0,
      latestActiveOperation: null,
      unavailable: true,
      errorCode: "BOOTSTRAP_OPERATION_SUMMARY_UNAVAILABLE",
    };
  }
}

export async function getBootstrapPlanSnapshot(command = {}) {
  const shop = requireShopScope(command?.shop);
  try {
    const subscription = await getSubscriptionPlanSnapshotByShop(shop);
    return buildPlanSnapshot(subscription, false);
  } catch (error) {
    return buildPlanSnapshot(null, true);
  }
}
