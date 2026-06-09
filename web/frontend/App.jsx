import { BrowserRouter } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppLink, NavigationMenu } from "@shopify/app-bridge/actions";
import { Banner, BlockStack, Box, Button, Card, Frame, Page, Text } from "@shopify/polaris";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";

import Routes from "./Routes";
import { QueryProvider, PolarisProvider } from "./components";
import {
  AuthenticatedFetchProvider,
  AppBridgeProvider,
  ToastProvider,
  useAppBridge,
} from "./components/providers";
import ErrorBoundary from "./components/Error/ErrorBoundary";

import { getShopifyContext } from "./utils/shopifyContext";

import "./app.css";

const pages = import.meta.glob("./pages/**/!(*.test.[jt]sx)*.([jt]sx)");

function getEmbeddedRouterBasename() {
  if (typeof window === "undefined") {
    return "/";
  }

  const match = window.location.pathname.match(/^(\/store\/[^/]+\/apps\/[^/]+)(?:\/|$)/);
  return match?.[1] || "/";
}

export default function App() {
  const { host } = getShopifyContext();
  const hasApiKey = Boolean(import.meta.env.VITE_SHOPIFY_API_KEY);

  const [isSyncing, setIsSyncing] = useState(false);
  const { t } = useTranslation();
  const routerBasename = getEmbeddedRouterBasename();

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
      <AppBridgeProvider host={host}>
        <PolarisProvider>
          <AuthenticatedFetchProvider>
            <Frame>
              <ToastProvider>
                <QueryProvider>
                  <EmbeddedNavMenu isSyncing={isSyncing} t={t} />
                  <ErrorBoundary context="App routes">
                    <Routes pages={pages} data={{ setIsSyncing }} />
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
    <Page title="Open MetaMatrix from Shopify Admin">
      <Card roundedAbove="sm">
        <Box padding="500">
          <BlockStack gap="300">
            <Banner tone="warning">
              <p>
                {missingApiKey
                  ? "Shopify API key is not configured for this frontend build."
                  : "Shopify embedded context was not available for this page."}
              </p>
            </Banner>
            <Text as="p" tone="subdued">
              {missingApiKey
                ? "Configure the frontend environment and reload from Shopify Admin."
                : "Open this app from Shopify Admin Apps, then retry from the app navigation."}
            </Text>
            <Box>
              <Button onClick={() => window.location.reload()} variant="primary">
                Retry
              </Button>
            </Box>
          </BlockStack>
        </Box>
      </Card>
    </Page>
  );
}

function EmbeddedNavMenu({ isSyncing, t }) {
  const location = useLocation();
  const appBridge = useAppBridge();

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
    [t],
  );

  useEffect(() => {
    if (!appBridge) {
      return;
    }

    const visibleItems = isSyncing ? [] : items;
    const links = visibleItems.map((item) => AppLink.create(appBridge, item));
    const activeLink = links.find((link) =>
      location.pathname.startsWith(link.options.destination),
    );

    NavigationMenu.create(appBridge, {
      items: links,
      active: activeLink,
    });
  }, [appBridge, isSyncing, items, location.pathname]);

  return null;
}
