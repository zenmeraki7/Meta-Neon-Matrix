import { getStoreCreditFlagsByShop } from "../repositories/storeRepository.js";
import { findLatestSubscriptionByShop } from "../repositories/subscriptionRepository.js";
import {
  buildPlanCapabilities,
  SCHEDULED_EXPORTS_FEATURE,
  SCHEDULED_EXPORTS_UPGRADE_MESSAGE,
} from "./entitlement/planCapabilities.js";

export function hasScheduledExportAccess(subscription = {}) {
  return buildPlanCapabilities(subscription).canScheduleExports;
}

export async function assertScheduledExportAccess(subscription = {}) {
  if (hasScheduledExportAccess(subscription)) return;

  const capability = buildPlanCapabilities(subscription);
  const error = new Error("SCHEDULED_EXPORT_PLAN_UPGRADE_REQUIRED");
  error.code = "UPGRADE_REQUIRED";
  error.statusCode = 403;
  error.details = {
    feature: SCHEDULED_EXPORTS_FEATURE,
    upgradeRequired: true,
    billingUrl: capability.billingUrl,
  };
  error.expose = true;
  error.publicMessage = SCHEDULED_EXPORTS_UPGRADE_MESSAGE;
  throw error;
}

export async function getScheduledExportPlanContext(shop) {
  const [store, subscription] = await Promise.all([
    getStoreCreditFlagsByShop(shop),
    findLatestSubscriptionByShop(shop),
  ]);

  if (store?.isCreditAvailable) {
    return {
      shop,
      planKey: "PRO_MONTHLY",
      planName: "Pro Plan (Grandfathered)",
      status: "ACTIVE",
      isCreditUser: true,
      capabilities: buildPlanCapabilities({
        planKey: "PRO_MONTHLY",
        planName: "Pro Plan (Grandfathered)",
        status: "ACTIVE",
        isCreditUser: true,
      }),
    };
  }

  const planContext = {
    shop,
    planKey: subscription?.planKey || "FREE",
    planName: subscription?.planName || "Free Plan",
    status: subscription?.status || "FREE",
    isCreditUser: false,
  };

  return {
    ...planContext,
    capabilities: buildPlanCapabilities(planContext),
  };
}
