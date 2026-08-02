function createAuthError(code, message, cause = null) {
  const error = new Error(message);
  error.name = "ShopifyAuthenticationError";
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

export async function getFreshShopifySessionToken(shopify) {
  if (!shopify || typeof shopify.idToken !== "function") {
    throw createAuthError(
      "APP_BRIDGE_CONTEXT_MISSING",
      "Shopify App Bridge is not available in this embedded app."
    );
  }

  let token;
  try {
    token = await shopify.idToken();
  } catch (cause) {
    throw createAuthError(
      "SESSION_TOKEN_ACQUISITION_FAILED",
      "Shopify could not issue a fresh session token.",
      cause
    );
  }

  if (!String(token || "").trim()) {
    throw createAuthError(
      "SESSION_TOKEN_UNAVAILABLE",
      "Shopify returned an empty session token."
    );
  }

  return String(token).trim();
}

export function createShopifyAuthenticatedFetch({
  getSessionToken,
  fetchImpl,
}) {
  if (typeof getSessionToken !== "function") {
    return async () => {
      throw createAuthError(
        "APP_BRIDGE_CONTEXT_MISSING",
        "Shopify App Bridge authentication is not initialized."
      );
    };
  }

  if (typeof fetchImpl !== "function") {
    return async () => {
      throw createAuthError(
        "NETWORK_FAILURE",
        "The browser fetch implementation is not available."
      );
    };
  }

  let pendingTokenPromise = null;

  const acquireToken = () => {
    if (!pendingTokenPromise) {
      pendingTokenPromise = Promise.resolve()
        .then(() => getSessionToken())
        .finally(() => {
          pendingTokenPromise = null;
        });
    }

    return pendingTokenPromise;
  };

  const requestOnce = async (uri, options) => {
    const token = await acquireToken();
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${token}`);

    try {
      return await fetchImpl(uri, {
        credentials: "include",
        ...options,
        headers,
      });
    } catch (cause) {
      if (cause?.code) throw cause;
      throw createAuthError(
        "NETWORK_FAILURE",
        "The authenticated request could not reach the server.",
        cause
      );
    }
  };

  return async (uri, options = {}) => {
    const firstResponse = await requestOnce(uri, options);
    if (firstResponse.status !== 401) return firstResponse;

    return requestOnce(uri, options);
  };
}
