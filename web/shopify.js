// web/shopify.js

import { BillingInterval } from "@shopify/shopify-api";
import { shopifyApp } from "@shopify/shopify-app-express";
import { PostgreSQLSessionStorage } from
  "@shopify/shopify-app-session-storage-postgresql";
import dotenv from "dotenv";

import PrivacyWebhookHandlers from "./privacy.js";

dotenv.config();

/**
 * Required by hosted PostgreSQL providers such as Neon.
 *
 * Prefer configuring SSL through DATABASE_URL when possible:
 * postgresql://...?sslmode=require
 */
process.env.PGSSLMODE = process.env.PGSSLMODE || "require";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not defined – required for Shopify session storage",
  );
}

const sessionStorage = new PostgreSQLSessionStorage(DATABASE_URL);

/**
 * Keep the API version explicit.
 * Do not import LATEST_API_VERSION because the installed
 * @shopify/shopify-api package does not export it.
 */
const SHOPIFY_API_VERSION =
  process.env.SHOPIFY_API_VERSION || "2026-07";

export const billingConfig = {
  "Free Version": {
    amount: 0,
    currencyCode: "USD",
    interval: BillingInterval.OneTime,
  },

  "Basic (Monthly)": {
    amount: 10,
    currencyCode: "USD",
    interval: BillingInterval.Every30Days,
  },

  "Advanced (Monthly)": {
    amount: 25,
    currencyCode: "USD",
    interval: BillingInterval.Every30Days,
  },

  "Pro (Monthly)": {
    amount: 50,
    currencyCode: "USD",
    interval: BillingInterval.Every30Days,
  },
};

const shopify = shopifyApp({
  api: {
    apiVersion: SHOPIFY_API_VERSION,

    billing: billingConfig,

    /**
     * Disable Shopify API library logging.
     *
     * Keep this only if your installed package supports logger
     * customization in this location.
     */
    logger: {
      log: () => {},
      debug: () => {},
      info: () => {},
      warning: () => {},
      error: () => {},
    },

    future: {
      customerAddressDefaultFix: true,
      lineItemBilling: true,
      unstable_managedPricingSupport: true,
    },
  },

  auth: {
    path: "/api/auth",
    callbackPath: "/api/auth/callback",
    isOnline: false,
  },

  webhooks: {
    path: "/api/webhooks",
    ...PrivacyWebhookHandlers,
  },

  sessionStorage,
});

export default shopify;