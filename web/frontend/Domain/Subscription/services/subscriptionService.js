import { protectedApiGet, protectedApiPost } from "../../../api/protectedApiClient";
import { getDefaultPricingPlans } from "../config/pricingPlans";

const SUBSCRIPTION_PLANS_PATH = "/api/subscription/get-plans";
const FALLBACK_CAPABILITIES = Object.freeze({
  canScheduleEdits: false,
  canScheduleExports: false,
  isDevelopmentPlan: false,
  planName: "Free Plan",
  upgradeUrl: "/pricing",
  billingUrl: "/pricing",
});

export const subscriptionService = {
  async getSubscriptionPlans() {
    let data;

    try {
      data = await protectedApiGet(SUBSCRIPTION_PLANS_PATH);
    } catch (error) {
      return {
        success: true,
        plans: getDefaultPricingPlans(),
        capabilities: FALLBACK_CAPABILITIES,
        fallback: true,
        message: error?.message || "Using default pricing plans because billing data could not be loaded.",
      };
    }

    if (data?.success !== true) {
      return {
        success: true,
        plans: getDefaultPricingPlans(),
        capabilities: FALLBACK_CAPABILITIES,
        fallback: true,
        message: data?.message || data?.error || "Failed to load subscription plans",
      };
    }

    if (!Array.isArray(data.plans)) {
      return {
        success: true,
        plans: getDefaultPricingPlans(),
        capabilities: FALLBACK_CAPABILITIES,
        fallback: true,
        message: "Subscription plans response was invalid",
      };
    }

    if (data.plans.length === 0) {
      return {
        success: true,
        plans: getDefaultPricingPlans(),
        capabilities: FALLBACK_CAPABILITIES,
        fallback: true,
        message: "No pricing plans were returned by the server.",
      };
    }

    return data;
  },

  async createSubscription(plan) {
    return protectedApiPost("/api/subscription/create-subscription", {
      planKey: plan.key,
    }, {
      idempotent: true,
    });
  },
};
