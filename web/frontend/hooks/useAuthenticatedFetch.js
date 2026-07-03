// web/frontend/src/hooks/useAuthenticatedFetch.js

import { useCallback, useMemo } from "react";
import { triggerGlobalReauth } from "../api/reauthHandler";
import { useAppBridgeAuth } from "../components/providers/AppBridgeProvider";

function createAuthFetchUnavailableError() {
  const error = new Error(
    "Shopify authenticated fetch is not available yet. Open the app from Shopify Admin and reload.",
  );
  error.code = "AUTH_FETCH_UNAVAILABLE";
  return error;
}

/**
 * Returns an authenticated fetch function that includes the Shopify session token.
 * Supports Shopify managed authenticated fetch when available,
 * and falls back to idToken-based Authorization header.
 */
export function useAuthenticatedFetch() {
  const { getSessionToken } = useAppBridgeAuth();
  const fetchFunction = useMemo(() => {
    if (typeof window === "undefined") {
      return null;
    }

    const shopifyGlobal = window.shopify || null;

    if (typeof shopifyGlobal?.fetch === "function") {
      return shopifyGlobal.fetch.bind(shopifyGlobal);
    }

    if (typeof getSessionToken !== "function") {
      return null;
    }

    return async (uri, options = {}) => {
      const headers = new Headers(options.headers || {});

      if (!headers.has("Authorization")) {
        const token = await getSessionToken();
        if (!token) {
          throw createAuthFetchUnavailableError();
        }
        headers.set("Authorization", `Bearer ${token}`);
      }

      return window.fetch(uri, {
        credentials: options.credentials || "include",
        ...options,
        headers,
      });
    };
  }, [getSessionToken]);

  return useCallback(
    async (uri, options = {}) => {
      if (!fetchFunction) {
        throw createAuthFetchUnavailableError();
      }

      const response = await fetchFunction(uri, {
        credentials: options.credentials || "include",
        ...options,
      });

      if (
        response.headers.get("X-Shopify-API-Request-Failure-Reauthorize") ===
        "1"
      ) {
        const redirectUrl = response.headers.get(
          "X-Shopify-API-Request-Failure-Reauthorize-Url",
        );

        if (redirectUrl) {
          triggerGlobalReauth(redirectUrl);
        }

        const reauthError = new Error("Reauthorization required");
        reauthError.code = "REAUTH_REQUIRED";
        reauthError.redirectUrl = redirectUrl || null;
        throw reauthError;
      }

      return response;
    },
    [fetchFunction],
  );
}
