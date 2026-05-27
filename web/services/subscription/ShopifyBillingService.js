import shopify from "../../shopify.js";

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
    const mutation = `
      mutation CreateSubscription(
        $name: String!
        $returnUrl: URL!
        $trialDays: Int!
        $price: Decimal!
      ) {
        appSubscriptionCreate(
          test:true
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
        },
      },
    });
    const payload = result?.body?.data?.appSubscriptionCreate;
    if (payload?.userErrors?.length) {
      throw new Error(payload.userErrors[0]?.message || "SHOPIFY_BILLING_CREATE_FAILED");
    }
    return payload;
  }
}

export default ShopifyBillingService;
