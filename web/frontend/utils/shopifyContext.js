// web/frontend/src/utils/shopifyContext.js

const STORAGE_KEY = "metamatrix.shopifyContext";

function readStoredContext() {
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

function writeStoredContext(context) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(context));
  } catch {
    // Ignore blocked storage; URL context is still enough for the first load.
  }
}

function getGlobalHost() {
  return window?.shopify?.config?.host || window?.Shopify?.host || null;
}

function encodeHost(value) {
  try {
    return window.btoa(value);
  } catch {
    return null;
  }
}

function getContextFromReferrer() {
  try {
    const referrer = document.referrer ? new URL(document.referrer) : null;
    const storeHandle =
      referrer?.hostname === "admin.shopify.com"
        ? referrer.pathname.match(/\/store\/([^/]+)/)?.[1]
        : null;

    if (!storeHandle) {
      return {};
    }

    return {
      shop: `${storeHandle}.myshopify.com`,
      host: encodeHost(`admin.shopify.com/store/${storeHandle}`),
    };
  } catch {
    return {};
  }
}

export function getShopifyContext() {
  const params = new URLSearchParams(window.location.search);
  const stored = readStoredContext();
  const referrerContext = getContextFromReferrer();

  const shop = params.get("shop") || stored.shop || referrerContext.shop || null;
  const host =
    params.get("host") ||
    getGlobalHost() ||
    stored.host ||
    referrerContext.host ||
    null;

  if (host || shop) {
    writeStoredContext({ shop, host });
  }

  return { shop, host };
}

export function assertShopifyEmbeddedContext() {
  const { shop, host } = getShopifyContext();

  if (!host) {
    throw new Error(
      "Missing Shopify host. Open the app from Shopify Admin, not directly from the tunnel URL."
    );
  }

  return { shop, host };
}
