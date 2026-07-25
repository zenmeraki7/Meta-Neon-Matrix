import { db } from "../repositories/repositoryDb.js";

export function assertMockBillingNotProduction() {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.DEV_BILLING_MODE === "mock"
  ) {
    throw new Error("DEV_BILLING_MODE=mock is not allowed in production");
  }
}

assertMockBillingNotProduction();

export function isMockBillingEnabled() {
  assertMockBillingNotProduction();
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.SHOPIFY_BILLING_ENABLED === "false" &&
    process.env.DEV_BILLING_MODE === "mock"
  );
}

export async function createMockBillingSubscription({ shop, plan }) {
  assertMockBillingNotProduction();
  if (!isMockBillingEnabled()) {
    const error = new Error("Mock billing is disabled.");
    error.code = "MOCK_BILLING_DISABLED";
    error.expose = true;
    throw error;
  }

  const subscriptionId = `mock:${shop}:${plan.planKey}`;
  const currentPeriodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await db.subscription.upsert({
    where: { shop },
    create: {
      shop,
      planKey: plan.planKey,
      planName: plan.name,
      subscriptionId,
      status: "ACTIVE",
      currentPeriodEnd,
    },
    update: {
      planKey: plan.planKey,
      planName: plan.name,
      subscriptionId,
      status: "ACTIVE",
      pendingSubscriptionId: null,
      pendingPlanKey: null,
      pendingPlanName: null,
      currentPeriodEnd,
    },
  });

  await db.billingEvent.create({
    data: {
      shop,
      domainEventType: "MOCK_SUBSCRIPTION_ACTIVATED",
      sourceSystem: "MOCK",
      payload: {
        plan: plan.slug,
        planKey: plan.planKey,
        subscriptionId,
        currentPeriodEnd: currentPeriodEnd.toISOString(),
      },
    },
  });

  return {
    subscriptionId,
    currentPeriodEnd,
  };
}
