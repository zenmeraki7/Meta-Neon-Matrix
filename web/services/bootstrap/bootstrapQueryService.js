import {
  getOperationSummaryByShop,
} from "../../repositories/bootstrapRepository.js";
import { getPlansArray } from "../SubscriptionService/SubscriptionService.js";
import { resolveBillingState } from "../subscriptionAuthorityService.js";

export async function getOperationSummary(command = Object.freeze({})) {
  const shop = String(command?.shop || "").trim();
  return getOperationSummaryByShop(shop);
}

export async function getBootstrapPlanSnapshot(shop) {
  const billingState = await resolveBillingState({ shop });
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
