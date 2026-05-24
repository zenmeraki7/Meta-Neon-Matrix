import { useCallback } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { Redirect } from "@shopify/app-bridge/actions";

export function useEmbeddedRedirect() {
  const app = useAppBridge();

  const redirectRemote = useCallback(
    (url) => {
      if (!url) return;
      try {
        const redirect = Redirect.create(app);
        redirect.dispatch(Redirect.Action.REMOTE, url);
      } catch {
        if (typeof window !== "undefined" && window.top) {
          window.top.location.href = url;
        }
      }
    },
    [app],
  );

  return { redirectRemote };
}
