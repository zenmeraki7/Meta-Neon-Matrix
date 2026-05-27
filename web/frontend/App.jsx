import { BrowserRouter } from "react-router-dom";
import { useTranslation } from "react-i18next";
import createApp from "@shopify/app-bridge";
import { AppLink, NavigationMenu } from "@shopify/app-bridge/actions";
import { Frame } from "@shopify/polaris";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";

import Routes from "./Routes";
import { QueryProvider, PolarisProvider } from "./components";
import {
  AuthenticatedFetchProvider,
  ToastProvider,
} from "./components/providers";
import ErrorBoundary from "./components/Error/ErrorBoundary";

import { getShopifyContext } from "./utils/shopifyContext";

import "./app.css";

const pages = import.meta.glob("./pages/**/!(*.test.[jt]sx)*.([jt]sx)");

export default function App() {
  const { host } = getShopifyContext();

  const [isSyncing, setIsSyncing] = useState(false);
  const { t } = useTranslation();

  if (!host) {
    return <MissingEmbeddedContext />;
  }

  return (
    <BrowserRouter basename="/">
      <PolarisProvider>
        <AuthenticatedFetchProvider>
          <ToastProvider>
            <QueryProvider>
              <EmbeddedNavMenu isSyncing={isSyncing} t={t} />
              <Frame>
                <ErrorBoundary context="App routes">
                  <Routes pages={pages} data={{ setIsSyncing }} />
                </ErrorBoundary>
              </Frame>
            </QueryProvider>
          </ToastProvider>
        </AuthenticatedFetchProvider>
      </PolarisProvider>
    </BrowserRouter>
  );
}

function MissingEmbeddedContext() {
  return (
    <div className="embedded-context-error">
      <h1>Open MetaMatrix from Shopify Admin</h1>
      <p>
        Shopify embedded context was not available for this page. Open the app
        from Shopify Admin Apps, then use the app navigation again.
      </p>
    </div>
  );
}

function EmbeddedNavMenu({ isSyncing, t }) {
  const location = useLocation();
  const { host } = getShopifyContext();
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
