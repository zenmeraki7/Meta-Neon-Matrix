// web/frontend/src/hooks/useAuthenticatedFetch.js

import { useCallback, useMemo } from "react";
import { triggerGlobalReauth } from "../api/reauthHandler";
import { useAppBridgeAuth } from "../components/providers/AppBridgeProvider";
import { createShopifyAuthenticatedFetch } from "../api/shopifyAuthenticatedFetch";

/**
 * Returns an authenticated fetch function that includes the Shopify session token.
 * Supports Shopify managed authenticated fetch when available,
 * and falls back to idToken-based Authorization header.
 */
export function useAuthenticatedFetch() {
  const { getSessionToken } = useAppBridgeAuth();
  const fetchFunction = useMemo(() => {
    const fetchImpl =
      typeof window !== "undefined" && typeof window.fetch === "function"
        ? window.fetch.bind(window)
        : null;
    return createShopifyAuthenticatedFetch({ getSessionToken, fetchImpl });
  }, [getSessionToken]);

  return useCallback(
    async (uri, options = {}) => {
      const response = await fetchFunction(uri, {
        credentials: options.credentials || "include",
        ...options,
      });

      if (
        response.headers.get("X-Shopify-API-Request-Failure-Reauthorize") ===
        "1"
      ) {
        const redirectUrl = response.headers.get(
          "X-Shopify-API-Request-Failure-Reauthorize-Url"
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
    [fetchFunction]
  );
}
