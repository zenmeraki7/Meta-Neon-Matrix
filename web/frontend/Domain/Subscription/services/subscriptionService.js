import { protectedApiGet, protectedApiPost } from "../../../api/protectedApiClient";

export const subscriptionService = {
  async getSubscriptionPlans() {
    return protectedApiGet("/api/subscription/get-plans");
  },

  async createSubscription(plan) {
    return protectedApiPost("/api/subscription/create-subscription", {
      planKey: plan.key,
    }, {
      idempotent: true,
    });
  },
};
