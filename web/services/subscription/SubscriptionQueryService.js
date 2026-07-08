import { getPlansArray } from "../SubscriptionService/SubscriptionService.js";
import { resolveBillingState } from "../subscriptionAuthorityService.js";
import logger from "../../utils/loggerUtils.js";

export async function getPlanSnapshot(command = Object.freeze({})) {
  const shop = String(command?.shop || "").trim();
  let billingState = null;

  try {
    billingState = await resolveBillingState({ shop });
  } catch (error) {
    logger.warn("Unable to load billing state for subscription plan snapshot", {
      shop,
      code: error?.code,
      message: error?.message,
    });
    throw error;
  }

  const currentPlanKey = String(billingState?.planKey || "FREE");
  const currentPlanName =
    getPlansArray().find((plan) => plan.key === currentPlanKey)?.name || "Free Plan";

  const plans = getPlansArray().map((plan) => ({
    ...plan,
    isCurrent: plan.key === currentPlanKey,
  }));

  return {
    currentPlanKey,
    planName: billingState?.planName || currentPlanName,
    capabilities: billingState?.capabilities || {},
    billingState: billingState?.billingState || "FREE",
    subscriptionSource: billingState?.subscriptionSource || "UNKNOWN",
    plans,
  };
}
