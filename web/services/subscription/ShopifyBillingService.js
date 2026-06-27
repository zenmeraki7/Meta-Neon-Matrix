import shopify from "../../shopify.js";
import logger from "../../utils/loggerUtils.js";

function buildBillingError(code, message, details = null) {
  const error = new Error(message || code);
  error.code = code;
  error.expose = true;
  error.details = details;
  return error;
}

function normalizeBillingCreateError(message, details = null) {
  const text = String(message || "").trim();
  if (text.includes("Apps without a public distribution cannot use the Billing API")) {
    return buildBillingError(
      "BILLING_API_UNAVAILABLE",
      "Shopify billing is unavailable because this app is not configured for public distribution. Enable public distribution for the app before testing paid plan upgrades.",
      details,
    );
  }

  return buildBillingError(
    "SHOPIFY_BILLING_CREATE_FAILED",
    text || "Shopify billing subscription could not be created.",
    details,
  );
}

export class ShopifyBillingService {
  constructor(session) {
    this.client = new shopify.api.clients.Graphql({ session });
  }

  async cancelSubscription(subscriptionId) {
    const mutation = `
      mutation CancelSubscription($id: ID!) {
        appSubscriptionCancel(id: $id) {
          userErrors { field message }
          appSubscription { id status }
        }
      }
    `;
    const result = await this.client.query({
      data: { query: mutation, variables: { id: subscriptionId } },
    });
    const payload = result?.body?.data?.appSubscriptionCancel;
    if (payload?.userErrors?.length) {
      throw new Error(payload.userErrors[0]?.message || "SHOPIFY_BILLING_CANCEL_FAILED");
    }
    return payload?.appSubscription || null;
  }

  async createSubscription({ name, returnUrl, trialDays, price }) {
    const test = String(process.env.SHOPIFY_BILLING_TEST_MODE || "").trim()
      ? String(process.env.SHOPIFY_BILLING_TEST_MODE).toLowerCase() === "true"
      : process.env.NODE_ENV !== "production";
    const mutation = `
      mutation CreateSubscription(
        $name: String!
        $returnUrl: URL!
        $trialDays: Int!
        $price: Decimal!
        $test: Boolean!
      ) {
        appSubscriptionCreate(
          test: $test
          name: $name
          returnUrl: $returnUrl
          trialDays: $trialDays
          lineItems: [{
            plan: {
              appRecurringPricingDetails: {
                price: { amount: $price, currencyCode: USD }
                interval: EVERY_30_DAYS
              }
            }
          }]
        ) {
          appSubscription { id status }
          confirmationUrl
          userErrors { field message }
        }
      }
    `;
    const result = await this.client.query({
      data: {
        query: mutation,
        variables: {
          name,
          returnUrl,
          trialDays,
          price: String(price),
          test,
        },
      },
    });
    const payload = result?.body?.data?.appSubscriptionCreate;
    logger.info("Shopify appSubscriptionCreate response", {
      name,
      returnUrl,
      price: String(price),
      test,
      appSubscription: payload?.appSubscription || null,
      confirmationUrlPresent: Boolean(payload?.confirmationUrl),
      userErrors: payload?.userErrors || [],
      graphQLErrors: result?.body?.errors || [],
    });

    if (!payload) {
      throw buildBillingError(
        "SHOPIFY_BILLING_CREATE_FAILED",
        "Shopify billing response did not include appSubscriptionCreate.",
        { response: result?.body || null },
      );
    }

    if (payload?.userErrors?.length) {
      logger.warn("Shopify appSubscriptionCreate returned userErrors", {
        name,
        returnUrl,
        userErrors: payload.userErrors,
      });
      throw normalizeBillingCreateError(payload.userErrors[0]?.message, {
        userErrors: payload.userErrors,
      });
    }
    return payload;
  }

  async getActiveSubscriptions() {
    const query = `
      query CurrentAppSubscriptions {
        currentAppInstallation {
          activeSubscriptions {
            id
            name
            status
            trialDays
            createdAt
            currentPeriodEnd
            lineItems {
              plan {
                pricingDetails {
                  ... on AppRecurringPricing {
                    interval
                    price {
                      amount
                      currencyCode
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;
    const result = await this.client.query({ data: { query } });
    const activeSubscriptions =
      result?.body?.data?.currentAppInstallation?.activeSubscriptions || [];

    logger.info("Shopify active subscriptions response", {
      count: activeSubscriptions.length,
      subscriptions: activeSubscriptions.map((subscription) => ({
        id: subscription.id,
        name: subscription.name,
        status: subscription.status,
        currentPeriodEnd: subscription.currentPeriodEnd || null,
      })),
      graphQLErrors: result?.body?.errors || [],
    });

    return activeSubscriptions;
  }
}

export default ShopifyBillingService;
