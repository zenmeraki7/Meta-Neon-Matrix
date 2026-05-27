// web/frontend/src/api/authenticatedFetchRegistry.js

let authFetch = null;

export function setAuthenticatedFetch(fetchImpl) {
  authFetch = typeof fetchImpl === "function" ? fetchImpl : null;
}

export function getAuthenticatedFetch() {
  return authFetch;
}

function requireAuthenticatedFetch() {
  const authenticatedFetch = getAuthenticatedFetch();

  if (!authenticatedFetch) {
    throw new Error(
      "Authenticated fetch is not ready. Make sure AuthenticatedFetchProvider is mounted before API calls."
    );
  }

  return authenticatedFetch;
}

export async function apiFetch(uri, options = {}) {
  const authenticatedFetch = requireAuthenticatedFetch();

  const headers = new Headers(options.headers || {});

  if (!headers.has("Content-Type") && options.body) {
    headers.set("Content-Type", "application/json");
  }

  const response = await authenticatedFetch(uri, {
    ...options,
    headers,
  });

  return response;
}

export async function apiJson(uri, options = {}) {
  const response = await apiFetch(uri, options);

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = new Error(
      data?.error || data?.message || `Request failed with status ${response.status}`
    );

    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}
