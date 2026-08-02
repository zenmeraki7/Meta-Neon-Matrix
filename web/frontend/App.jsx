import { BrowserRouter } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { NavMenu } from "@shopify/app-bridge-react";
import {
  BlockStack,
  Box,
  Frame,
} from "@shopify/polaris";
import { useMemo, useState } from "react";

import Routes from "./Routes";
import { QueryProvider, PolarisProvider } from "./components";
import {
  AuthenticatedFetchProvider,
  AppBridgeProvider,
  ToastProvider,
} from "./components/providers";
import ErrorBoundary from "./components/Error/ErrorBoundary";


import { getShopifyContext } from "./utils/shopifyContext";

import "./app.css";

const pages = import.meta.glob("./pages/**/!(*.test.[jt]sx)*.([jt]sx)");

function getEmbeddedRouterBasename() {
  if (typeof window === "undefined") {
    return "/";
  }

  const match = window.location.pathname.match(
    /^(\/store\/[^/]+\/apps\/[^/]+)(?:\/|$)/
  );
  return match?.[1] || "/";
}

export default function App() {
  const { host } = getShopifyContext();
  const hasApiKey = Boolean(import.meta.env.VITE_SHOPIFY_API_KEY);

  const [isSyncing, setIsSyncing] = useState(false);
  const { t } = useTranslation();
  const routerBasename = getEmbeddedRouterBasename();
  const routeData = useMemo(() => ({ setIsSyncing }), []);

  if (!host || !hasApiKey) {
    return (
      <BrowserRouter basename={routerBasename}>
        <PolarisProvider>
          <MissingEmbeddedContext missingApiKey={!hasApiKey} />
        </PolarisProvider>
      </BrowserRouter>
    );
  }

  return (
    <BrowserRouter basename={routerBasename}>
      <AppBridgeProvider>
        <PolarisProvider>
          <AuthenticatedFetchProvider>
            <Frame>
              <ToastProvider>
                <QueryProvider>
                  <EmbeddedNavMenu isSyncing={isSyncing} t={t} />
                  <ErrorBoundary context="App routes">
                    <Routes pages={pages} data={routeData} />
                  </ErrorBoundary>
                </QueryProvider>
              </ToastProvider>
            </Frame>
          </AuthenticatedFetchProvider>
        </PolarisProvider>
      </AppBridgeProvider>
    </BrowserRouter>
  );
}

function MissingEmbeddedContext({ missingApiKey = false }) {
  return (
    <s-page heading="Open MetaMatrix from Shopify Admin">
      <s-section>
        <Box padding="500">
          <BlockStack gap="300">
            <s-banner tone="warning" heading={missingApiKey ? "API Key Missing" : "Context Unavailable"}>
              <s-text>
                {missingApiKey
                  ? "Shopify API key is not configured for this frontend build."
                  : "Shopify embedded context was not available for this page."}
              </s-text>
            </s-banner>
            <s-text tone="subdued">
              {missingApiKey
                ? "Configure the frontend environment and reload from Shopify Admin."
                : "Open this app from Shopify Admin Apps, then retry from the app navigation."}
            </s-text>
            <Box>
              <s-button
                onClick={() => window.location.reload()}
                variant="primary"
              >
                Retry
              </s-button>
            </Box>
          </BlockStack>
        </Box>
      </s-section>
    </s-page>
  );
}

function EmbeddedNavMenu({ isSyncing, t }) {
  const items = useMemo(
    () => [
      {
        destination: "/products",
        label: t("nav.products", { defaultValue: "Products" }),
      },
      {
        destination: "/history",
        label: t("nav.history", { defaultValue: "History" }),
      },
      {
        destination: "/refresh",
        label: t("nav.syncData", { defaultValue: "Sync Data" }),
      },
      {
        destination: "/spreadsheet",
        label: t("nav.spreadsheetEdit", {
          defaultValue: "Upload Spreadsheet",
        }),
      },
      {
        destination: "/suggestionPage",
        label: t("nav.suggestion", { defaultValue: "Suggestion" }),
      },
      {
        destination: "/pricing",
        label: t("nav.pricing", { defaultValue: "Pricing" }),
      },
    ],
    [t]
  );

  if (isSyncing) return null;

  return (
    <NavMenu>
      {items.map((item) => (
        <a href={item.destination} key={item.destination}>
          {item.label}
        </a>
      ))}
    </NavMenu>
  );
}
