import { prisma } from "../config/database.js";
import { PLANS } from "./SubscriptionService/SubscriptionService.js";

function resolvePlanLimit(planKey, status) {
  if (status !== "ACTIVE" && status !== "PENDING") {
    return 100;
  }
  if (planKey === "PRO_MONTHLY") return Number.MAX_SAFE_INTEGER;
  if (planKey === "ADVANCED_MONTHLY") return 1000;
  return 100;
}

export async function loadAuthoritativeSubscriptionForShop(shop) {
  if (!shop) {
    throw new Error("shop is required");
  }

  const store = await prisma.store.findUnique({
    where: { shopUrl: shop },
    select: { isCreditAvailable: true },
  });

  if (store?.isCreditAvailable === true) {
    return {
      shop,
      planKey: "PRO_MONTHLY",
      planName: "Pro Plan (Grandfathered)",
      limit: Number.MAX_SAFE_INTEGER,
      isUnlimited: true,
      status: "ACTIVE",
      isCreditUser: true,
      subscriptionId: null,
    };
  }

  const subscription = await prisma.subscription.findFirst({
    where: { shop },
    select: {
      planKey: true,
      planName: true,
      status: true,
      subscriptionId: true,
    },
  });

  const planKey = subscription?.planKey || "FREE";
  const status = subscription?.status || "FREE";
  const planName = subscription?.planName || PLANS?.[planKey]?.name || "Free Plan";
  const limit = resolvePlanLimit(planKey, status);

  return {
    shop,
    planKey,
    planName,
    limit,
    isUnlimited: limit === Number.MAX_SAFE_INTEGER,
    status,
    isCreditUser: false,
    subscriptionId: subscription?.subscriptionId || null,
  };
}

