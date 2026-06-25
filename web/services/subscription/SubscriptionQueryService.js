import { getPlansArray } from "../SubscriptionService/SubscriptionService.js";
import { findActiveSubscription } from "../../repositories/subscriptionRepository.js";
import { db } from "../../repositories/repositoryDb.js";
import { buildScheduleEditCapability } from "../entitlement/scheduledEditEntitlement.js";
import logger from "../../utils/loggerUtils.js";

export async function getPlanSnapshot(command = Object.freeze({})) {
  const shop = String(command?.shop || "").trim();
  let activeSubscription = null;
  let store = null;

  try {
    [activeSubscription, store] = await Promise.all([
      findActiveSubscription(shop),
      db.store.findUnique({
        where: { shopUrl: shop },
        select: { isCreditAvailable: true },
      }),
    ]);
  } catch (error) {
    logger.warn("Unable to load active subscription; falling back to Free plan", {
      shop,
      code: error?.code,
      message: error?.message,
    });
  }

  const currentPlanKey = String(activeSubscription?.planKey || "FREE");
  const currentPlanName =
    getPlansArray().find((plan) => plan.key === currentPlanKey)?.name || "Free Plan";
  const entitlementSnapshot = store?.isCreditAvailable
    ? {
      planKey: "PRO_MONTHLY",
      planName: "Pro Plan (Grandfathered)",
      status: "ACTIVE",
      isCreditUser: true,
    }
    : {
      planKey: currentPlanKey,
      planName: currentPlanName,
      status: activeSubscription?.status || "FREE",
      isCreditUser: false,
    };

  const plans = getPlansArray().map((plan) => ({
    ...plan,
    isCurrent: plan.key === currentPlanKey,
  }));

  return {
    currentPlanKey,
    planName: entitlementSnapshot.planName,
    capabilities: buildScheduleEditCapability(entitlementSnapshot),
    plans,
  };
}
