let authFetch = null;

export function setAuthenticatedFetch(fetchImpl) {
  authFetch = fetchImpl;
}

export function getAuthenticatedFetch() {
  return authFetch;
}

