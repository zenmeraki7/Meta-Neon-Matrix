// web/shopify.js

import {
  BillingInterval,
  LATEST_API_VERSION,
  DeliveryMethod,
  LogSeverity,
} from "@shopify/shopify-api";
import { shopifyApp } from "@shopify/shopify-app-express";
import { PostgreSQLSessionStorage } from "@shopify/shopify-app-session-storage-postgresql";
import dotenv from "dotenv";
import PrivacyWebhookHandlers from "./privacy.js";

dotenv.config();

process.env.PGSSLMODE = "require";
// process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not defined – required for Shopify session storage"
  );
}

const sessionStorage = new PostgreSQLSessionStorage(DATABASE_URL);

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
    apiVersion: LATEST_API_VERSION,
    // Disable Shopify framework logs
    logger: {
      log: () => {},
      debug: () => {},
      info: () => {},
      warning: () => {},
      error: () => {},
    },

    // Alternative:
    // logLevel: LogSeverity.Error,

    future: {
      customerAddressDefaultFix: true,
      lineItemBilling: true,
      unstable_managedPricingSupport: true,
    },

    billing: billingConfig,
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
