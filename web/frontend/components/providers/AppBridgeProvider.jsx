import { createContext, useCallback, useContext, useMemo } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import PropTypes from "prop-types";
import { getFreshShopifySessionToken } from "../../api/shopifyAuthenticatedFetch";

const AppBridgeAuthContext = createContext({
  getSessionToken: null,
});

const PERF_BUFFER_LIMIT = 200;

function markPerf(event, detail = {}) {
  if (
    typeof window === "undefined" ||
    typeof performance === "undefined"
  ) {
    return;
  }

  const key = `metamatrix:${event}`;

  try {
    performance.clearMarks(key);
    performance.mark(key);
  } catch {
    // Diagnostics must never affect authentication.
  }

  const buffer = Array.isArray(window.__MM_PERF__)
    ? window.__MM_PERF__
    : [];

  buffer.push({
    event,
    at: Date.now(),
    detail,
  });

  if (buffer.length > PERF_BUFFER_LIMIT) {
    buffer.splice(0, buffer.length - PERF_BUFFER_LIMIT);
  }

  window.__MM_PERF__ = buffer;
}

export function AppBridgeProvider({ children }) {
  const shopify = useAppBridge();
  const getSessionToken = useCallback(async () => {
    markPerf("token_fetch_start");
    try {
      const token = await getFreshShopifySessionToken(shopify);
      markPerf("token_fetch_end");
      return token;
    } catch (error) {
      markPerf("token_fetch_failed", { code: error?.code || "UNKNOWN" });
      throw error;
    }
  }, [shopify]);

  const authValue = useMemo(() => ({ getSessionToken }), [getSessionToken]);

  return (
    <AppBridgeAuthContext.Provider value={authValue}>
      {children}
    </AppBridgeAuthContext.Provider>
  );
}

AppBridgeProvider.propTypes = {
  children: PropTypes.node.isRequired,
};

export function useAppBridgeAuth() {
  return useContext(AppBridgeAuthContext);
}
