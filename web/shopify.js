let ApiVersion = { January26: "2026-01" };
let BillingInterval = { OneTime: "ONE_TIME", Every30Days: "EVERY_30_DAYS" };
let shopifyApp = null;
let PostgreSQLSessionStorage = null;

try {
  try {
    const dotenv = await import("dotenv");
    dotenv.default?.config?.();
  } catch {
    // Ignore missing dotenv
  }

  const shopifyApi = await import("@shopify/shopify-api");
  ApiVersion = shopifyApi.ApiVersion || ApiVersion;
  BillingInterval = shopifyApi.BillingInterval || BillingInterval;

  const appExpress = await import("@shopify/shopify-app-express");
  shopifyApp = appExpress.shopifyApp;

  const sessionStoragePg = await import("@shopify/shopify-app-session-storage-postgresql");
  PostgreSQLSessionStorage = sessionStoragePg.PostgreSQLSessionStorage;
} catch {
  // Gracefully handle uninstalled packages in unit test runner
}

export const billingConfig = {
  "Free Version": { amount: 0, currencyCode: "USD", interval: BillingInterval.OneTime },
  "Basic (Monthly)": { amount: 10, currencyCode: "USD", interval: BillingInterval.Every30Days },
  "Advanced (Monthly)": { amount: 25, currencyCode: "USD", interval: BillingInterval.Every30Days },
  "Pro (Monthly)": { amount: 50, currencyCode: "USD", interval: BillingInterval.Every30Days },
};

let shopifyInstance = null;

if (shopifyApp && PostgreSQLSessionStorage && process.env.DATABASE_URL) {
  try {
    const sessionStorage = new PostgreSQLSessionStorage(process.env.DATABASE_URL);
    shopifyInstance = shopifyApp({
      api: {
        apiVersion: ApiVersion.January26,
        future: {
          customerAddressDefaultFix: true,
          lineItemBilling: true,
          unstable_managedPricingSupport: true,
        },
        billing: billingConfig,
      },
      auth: { path: "/api/auth", callbackPath: "/api/auth/callback", isOnline: false },
      sessionStorage,
    });
  } catch {
    // Ignore init failure in test runner
  }
}

export const shopify = shopifyInstance;
export default shopifyInstance;
