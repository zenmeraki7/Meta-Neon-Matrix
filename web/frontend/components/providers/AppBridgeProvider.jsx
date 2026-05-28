import { createContext, useContext, useMemo } from "react";
import createApp from "@shopify/app-bridge";
import PropTypes from "prop-types";

const AppBridgeContext = createContext(null);

export function AppBridgeProvider({ host, children }) {
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

  return (
    <AppBridgeContext.Provider value={appBridge}>
      {children}
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
