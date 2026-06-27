// services/SubscriptionService.js
import shopify from "../../shopify.js";
import { resolveBillingPlan } from "../billingPlanRegistry.js";
export const PLANS = {
  FREE: {
    key: "FREE",
    name: "Starter",
    price: 0,
    compareAtPrice: null,
    trialDays: 0,
    isFree: true,
    description: "Perfect for trying out our app",
    highlight: "Get started with essential features",
    features: [
      "Basic features",
      "Up to 100 products",
      "Email support",
    ],
    buttonText: "Get Started",
    buttonVariant: "primary",
    
  },

  BASIC_MONTHLY: {
    key: "BASIC_MONTHLY",
    name: "Basic",
    price: 25,
    compareAtPrice: null,
    trialDays: 0,
    isFree: false,
    description: "For stores that need faster bulk editing workflows",
    highlight: "Unlimited products per task",
    features: [
      "All Free features",
      "Unlimited products per task",
      "Scheduled edits",
    ],
    buttonText: "Upgrade to Basic",
    buttonVariant: "primary",
  },

  ADVANCED_MONTHLY: {
    key: "ADVANCED_MONTHLY",
    name: "Advanced",
    price: 50,
    compareAtPrice: null,
    trialDays: 0,
    isFree: false,
    description: "For growing businesses",
    highlight: "Everything you need to scale",
    popular: true,
    features: [
      "All Free features",
      "Up to 1,000 products - Manual Edits",
      "Up to 1,000 products - Scheduled Edits",
    ],
    buttonText: "Upgrade to Advanced",
    buttonVariant: "primary",
  },

  PRO_MONTHLY: {
    key: "PRO_MONTHLY",
    name: "Professional",
    price: 110,
    compareAtPrice: null,
    trialDays: 0,
    isFree: false,
    description: "For established stores",
    highlight: "Premium features and dedicated support",
    features: [
      "All Advanced features",
      "Unlimited products",
      "Unlimited Scheduled Edit",
    ],
    buttonText: "Start Pro",
    buttonVariant: "primary",
  },
};

export const getPlansArray = () => Object.values(PLANS)

export const mapPlanKeyFromName = (planName) => {
  const billingPlan = resolveBillingPlan(planName);
  if (billingPlan?.planKey) {
    return billingPlan.planKey;
  }

  // Find the plan that matches the name
  const planEntry = Object.entries(PLANS).find(
    ([, plan]) => plan.name === planName
  );
  

  return planEntry ? planEntry[0] : "FREE";
};

export class SubscriptionService {
  constructor(session) {
    this.session = session;
    this.client = new shopify.api.clients.Graphql({ session });
  }

  async createPaidSubscription(plan, returnUrl) {
    const mutation = `
    mutation CreateSubscription(
      $name: String!
      $returnUrl: URL!
      $trialDays: Int!
      $price: Decimal!
    ) {
      appSubscriptionCreate(
        name: $name
        returnUrl: $returnUrl
        trialDays: $trialDays
        lineItems: [{
          plan: {
            appRecurringPricingDetails: {
              price: { amount: $price, currencyCode: USD }
            }
          }
        }]
      ) {
        appSubscription { id status }
        confirmationUrl
        userErrors { message }
      }
    }
  `;

    const res = await shopify.api.graphql(this.session, {
      data: {
        query: mutation,
        variables: {
          name: plan.name,
          returnUrl,
          trialDays: plan.trialDays,
          price: plan.price,
        },
      },
    });

    const data = res.body.data.appSubscriptionCreate;

    if (data.userErrors.length) {
      throw new Error(data.userErrors[0].message);
    }

    return data;
  }

  async cancelSubscription(subscriptionId) {
    const mutation = `
    mutation CancelSubscription($id: ID!) {
      appSubscriptionCancel(id: $id) {
        userErrors { message }
      }
    }
  `;

    await shopify.api.graphql(this.session, {
      data: {
        query: mutation,
        variables: { id: subscriptionId },
      },
    });
  }
}
