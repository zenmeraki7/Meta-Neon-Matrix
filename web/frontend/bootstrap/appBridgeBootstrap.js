import { setAuthenticatedFetch } from "../api/authenticatedFetchRegistry.js";

let currentBootstrapId = 0;

export function bootstrapAuthenticatedFetch(fetchImpl) {
  currentBootstrapId += 1;
  const bootstrapId = currentBootstrapId;
  setAuthenticatedFetch(fetchImpl);

  return () => {
    if (bootstrapId === currentBootstrapId) {
      setAuthenticatedFetch(null);
    }
  };
}
