import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import createApp from "@shopify/app-bridge";
import PropTypes from "prop-types";

const AppBridgeContext = createContext(null);
const AppBridgeAuthContext = createContext({
  getSessionToken: null,
});

function markPerf(event, detail = {}) {
  if (typeof window === "undefined" || typeof performance === "undefined") {
    return;
  }
  performance.mark(`metamatrix:${event}`);
  if (window.__MM_PERF__) {
    window.__MM_PERF__.push({ event, at: Date.now(), detail });
  } else {
    window.__MM_PERF__ = [{ event, at: Date.now(), detail }];
  }
}

export function AppBridgeProvider({ host, children }) {
  const tokenCacheRef = useRef({
    token: null,
    expiresAt: 0,
    inFlight: null,
  });
  const refreshTimeoutRef = useRef(null);

  const appBridge = useMemo(() => {
    if (!host || !import.meta.env.VITE_SHOPIFY_API_KEY) {
      return null;
    }

    return createApp({
      apiKey: import.meta.env.VITE_SHOPIFY_API_KEY,
      host,
      forceRedirect: true,
    });
  }, [host]);

  const authValue = useMemo(() => {
    const schedulePreRefresh = (expiresAt) => {
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
        refreshTimeoutRef.current = null;
      }
      const delayMs = Math.max(1_000, Number(expiresAt || 0) - Date.now() - 30_000);
      refreshTimeoutRef.current = setTimeout(() => {
        void getSessionToken();
      }, delayMs);
    };

    const getSessionToken = async () => {
      if (typeof window === "undefined") {
        return null;
      }
      const shopifyGlobal = window.shopify || null;
      const tokenProvider =
        typeof shopifyGlobal?.idToken === "function"
          ? shopifyGlobal.idToken.bind(shopifyGlobal)
          : null;

      if (!tokenProvider) {
        return null;
      }

      const now = Date.now();
      if (tokenCacheRef.current.token && tokenCacheRef.current.expiresAt > now + 30_000) {
        return tokenCacheRef.current.token;
      }

      if (tokenCacheRef.current.inFlight) {
        return tokenCacheRef.current.inFlight;
      }

      markPerf("token_fetch_start");
      tokenCacheRef.current.inFlight = tokenProvider()
        .then((token) => {
          const parsed = String(token || "").split(".")[1];
          let expMs = now + 55_000;
          if (parsed) {
            try {
              const payload = JSON.parse(window.atob(parsed.replace(/-/g, "+").replace(/_/g, "/")));
              if (payload?.exp) {
                expMs = Number(payload.exp) * 1000;
              }
            } catch {
              // Ignore payload parse issues and use conservative fallback.
            }
          }
          tokenCacheRef.current.token = token;
          tokenCacheRef.current.expiresAt = expMs;
          schedulePreRefresh(expMs);
          markPerf("token_fetch_end", { expiresAt: expMs });
          return token;
        })
        .finally(() => {
          tokenCacheRef.current.inFlight = null;
        });

      return tokenCacheRef.current.inFlight;
    };

    return {
      getSessionToken,
    };
  }, []);

  useEffect(() => {
    return () => {
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
      }
    };
  }, []);

  return (
    <AppBridgeContext.Provider value={appBridge}>
      <AppBridgeAuthContext.Provider value={authValue}>
        {children}
      </AppBridgeAuthContext.Provider>
    </AppBridgeContext.Provider>
  );
}

AppBridgeProvider.propTypes = {
  host: PropTypes.string,
  children: PropTypes.node.isRequired,
};

AppBridgeProvider.defaultProps = {
  host: null,
};

export function useAppBridge() {
  return useContext(AppBridgeContext);
}

export function useAppBridgeAuth() {
  return useContext(AppBridgeAuthContext);
}
