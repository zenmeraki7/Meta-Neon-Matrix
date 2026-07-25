import { useCallback } from "react";

export function useEmbeddedRedirect() {
  const redirectRemote = useCallback(
    (url) => {
      if (!url) return;

      if (typeof window === "undefined") {
        return;
      }

      const shopify = window.shopify || null;

      if (typeof shopify?.open === "function") {
        shopify.open(url, "_top");
        return;
      }

      if (typeof window.open === "function") {
        window.open(url, "_top");
        return;
      }

      window.location.assign(url);
    },
    [],
  );

  return { redirectRemote };
}
