import React, { Suspense, lazy, useEffect, useMemo } from "react";
import { Routes as ReactRouterRoutes, Route } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PageLoader from "./components/PageLoader";
import AppRouteErrorBoundary from "./components/Error/AppRouteErrorBoundary";

export default function Routes({ pages, data }) {
  const routes = useRoutes(pages);
  const notFoundRoute = routes.find(({ path }) => path === "/notFound");
  const NotFound = notFoundRoute?.component || null;
  const { i18n } = useTranslation();

  useEffect(() => {
    const warmNamespaces = ["products", "history"];
    const preload = () => {
      const missing = warmNamespaces.filter((ns) => !i18n.hasLoadedNamespace(ns));
      if (missing.length > 0) {
        void i18n.loadNamespaces(missing);
      }
    };
    if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
      const idleId = window.requestIdleCallback(preload);
      return () => window.cancelIdleCallback?.(idleId);
    }
    const timeoutId = setTimeout(preload, 0);
    return () => clearTimeout(timeoutId);
  }, [i18n]);

  return (
    <ReactRouterRoutes>
      {routes
        .filter(({ path }) => path !== "/notFound")
        .map(({ path, component: Component }) => (
          <Route
            key={path}
            path={path}
            element={
              <AppRouteErrorBoundary routePath={path}>
                <Suspense fallback={<PageLoader />}>
                  <RouteNamespaceLoader path={path}>
                    {path === "/" ? <Component data={data} /> : <Component />}
                  </RouteNamespaceLoader>
                </Suspense>
              </AppRouteErrorBoundary>
            }
          />
        ))}
      {NotFound && (
        <Route
          path="*"
          element={
            <AppRouteErrorBoundary routePath="*">
              <Suspense fallback={<PageLoader />}>
                <NotFound />
              </Suspense>
            </AppRouteErrorBoundary>
          }
        />
      )}
    </ReactRouterRoutes>
  );
}

function RouteNamespaceLoader({ path, children }) {
  const { i18n } = useTranslation();
  const namespaces = useMemo(() => getNamespacesForRoute(path), [path]);

  useEffect(() => {
    const missing = namespaces.filter((ns) => !i18n.hasLoadedNamespace(ns));
    if (missing.length === 0) {
      return;
    }
    void i18n.loadNamespaces(missing);
  }, [i18n, namespaces]);
  return children;
}

function getNamespacesForRoute(path) {
  if (
    path.startsWith("/products") ||
    path.startsWith("/edit") ||
    path.startsWith("/spreadsheet") ||
    path.startsWith("/refresh")
  ) {
    return ["common", "products"];
  }
  if (
    path.startsWith("/history") ||
    path.startsWith("/exportdata") ||
    path.startsWith("/exportDetails")
  ) {
    return ["common", "history"];
  }
  if (path.startsWith("/pricing") || path.startsWith("/subscription")) {
    return ["common", "subscription"];
  }
  if (path.startsWith("/suggestion")) {
    return ["common", "feedback"];
  }
  return ["common"];
}

function useRoutes(pages) {
  return Object.keys(pages)
    .map((key) => {
      let path = key
        .replace("./pages", "")
        .replace(/\.(t|j)sx?$/, "")
        .replace(/\/index$/i, "/")
        .replace(/\b[A-Z]/, (firstLetter) => firstLetter.toLowerCase())
        .replace(/\[(?:[.]{3})?(\w+?)\]/g, (_match, param) => `:${param}`);

      if (path.endsWith("/") && path !== "/") {
        path = path.substring(0, path.length - 1);
      }

      const loader = pages[key];
      const component = typeof loader === "function" ? lazy(loader) : loader?.default;

      if (!component) {
        console.warn(`${key} doesn't export a default React component`);
      }

      return {
        path,
        component,
      };
    })
    .filter((route) => route.component);
}
