import {
  getOperationSummaryByShop,
  getSubscriptionPlanSnapshotByShop,
} from "../../repositories/bootstrapRepository.js";
import { db } from "../../repositories/repositoryDb.js";
import { getPlansArray } from "../SubscriptionService/SubscriptionService.js";
import { buildScheduleEditCapability } from "../entitlement/scheduledEditEntitlement.js";

export async function getOperationSummary(command = Object.freeze({})) {
  const shop = String(command?.shop || "").trim();
  return getOperationSummaryByShop(shop);
}

export async function getBootstrapPlanSnapshot(shop) {
  const [subscription, store] = await Promise.all([
    getSubscriptionPlanSnapshotByShop(shop),
    db.store.findUnique({
      where: { shopUrl: String(shop || "").trim() },
      select: { isCreditAvailable: true },
    }),
  ]);
  const currentPlanKey =
    subscription && String(subscription.status || "").toUpperCase() === "ACTIVE"
      ? String(subscription.planKey || "FREE")
      : "FREE";
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
      status: subscription?.status || "FREE",
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
