import { useEffect } from "react";
import PropTypes from "prop-types";
import { useAuthenticatedFetch } from "../../hooks/useAuthenticatedFetch";
import { bootstrapAuthenticatedFetch } from "../../bootstrap/appBridgeBootstrap";

export function AuthenticatedFetchProvider({ children }) {
  const authenticatedFetch = useAuthenticatedFetch();

  useEffect(() => {
    return bootstrapAuthenticatedFetch(authenticatedFetch);
  }, [authenticatedFetch]);

  return children;
}

AuthenticatedFetchProvider.propTypes = {
  children: PropTypes.node.isRequired,
};

