import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useEmbeddedRedirect } from "./useEmbeddedRedirect";

export function useEmbeddedNavigate() {
  const navigate = useNavigate();
  const { redirectRemote } = useEmbeddedRedirect();

  return useCallback(
    (to, options) => {
      if (!to) return;

      const target = String(to);
      if (/^https?:\/\//i.test(target)) {
        redirectRemote(target);
        return;
      }

      navigate(to, options);
    },
    [navigate, redirectRemote],
  );
}
