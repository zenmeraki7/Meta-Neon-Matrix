import { getPlansArray } from "../SubscriptionService/SubscriptionService.js";
import { findActiveSubscription } from "../../repositories/subscriptionRepository.js";

export async function getPlanSnapshot(command = Object.freeze({})) {
  const shop = String(command?.shop || "").trim();
  const activeSubscription = await findActiveSubscription(shop);
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
