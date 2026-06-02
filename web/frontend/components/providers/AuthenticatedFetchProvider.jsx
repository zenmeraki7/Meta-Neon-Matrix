// web/frontend/src/components/providers/AuthenticatedFetchProvider.jsx

import { useEffect } from "react";
import PropTypes from "prop-types";
import { useAuthenticatedFetch } from "../../hooks/useAuthenticatedFetch";
import { bootstrapAuthenticatedFetch } from "../../bootstrap/appBridgeBootstrap";

export function AuthenticatedFetchProvider({ children }) {
  const authenticatedFetch = useAuthenticatedFetch();

  useEffect(() => {
    const cleanup = bootstrapAuthenticatedFetch(authenticatedFetch);

    return () => {
      cleanup?.();
    };
  }, [authenticatedFetch]);

  return children;
}

AuthenticatedFetchProvider.propTypes = {
  children: PropTypes.node.isRequired,
};