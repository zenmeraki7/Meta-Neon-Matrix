import React, { Suspense, lazy, useMemo } from "react";
import { Routes as ReactRouterRoutes, Route } from "react-router-dom";
import { i18n } from "./utils/i18nUtils";
import PageLoader from "./components/PageLoader";
import AppRouteErrorBoundary from "./components/Error/AppRouteErrorBoundary";

export default function Routes({ pages, data }) {
  const routes = useMemo(() => buildRoutes(pages), [pages]);
  const notFoundRoute = useMemo(
    () => routes.find(({ path }) => path === "/notFound"),
    [routes]
  );
  const NotFound = notFoundRoute?.component || null;

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
                  {path === "/" ? <Component data={data} /> : <Component />}
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

function buildRoutes(pages) {
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
      const component =
        typeof loader === "function"
          ? lazy(async () => {
              const [module] = await Promise.all([
                loader(),
                i18n.loadNamespaces(getNamespacesForRoute(path)),
              ]);

              return module;
            })
          : loader?.default;

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
