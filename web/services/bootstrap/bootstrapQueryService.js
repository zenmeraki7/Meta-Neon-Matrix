import {
  getOperationSummaryByShop,
  getSubscriptionPlanSnapshotByShop,
} from "../../repositories/bootstrapRepository.js";
import { getPlansArray } from "../SubscriptionService/SubscriptionService.js";

export async function getOperationSummary(command = Object.freeze({})) {
  const shop = String(command?.shop || "").trim();
  return getOperationSummaryByShop(shop);
}

export async function getBootstrapPlanSnapshot(shop) {
  const subscription = await getSubscriptionPlanSnapshotByShop(shop);
  const currentPlanKey =
    subscription && String(subscription.status || "").toUpperCase() === "ACTIVE"
      ? String(subscription.planKey || "FREE")
      : "FREE";

  const plans = getPlansArray().map((plan) => ({
    ...plan,
    isCurrent: plan.key === currentPlanKey,
  }));

  return {
    currentPlanKey,
    plans,
  };
}
