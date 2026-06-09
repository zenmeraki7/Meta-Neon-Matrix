import { getPlansArray } from "../SubscriptionService/SubscriptionService.js";
import { findActiveSubscription } from "../../repositories/subscriptionRepository.js";
import logger from "../../utils/loggerUtils.js";

export async function getPlanSnapshot(command = Object.freeze({})) {
  const shop = String(command?.shop || "").trim();
  let activeSubscription = null;

  try {
    activeSubscription = await findActiveSubscription(shop);
  } catch (error) {
    logger.warn("Unable to load active subscription; falling back to Free plan", {
      shop,
      code: error?.code,
      message: error?.message,
    });
  }

  const currentPlanKey = String(activeSubscription?.planKey || "FREE");

  const plans = getPlansArray().map((plan) => ({
    ...plan,
    isCurrent: plan.key === currentPlanKey,
  }));

  return {
    currentPlanKey,
    plans,
  };
}
