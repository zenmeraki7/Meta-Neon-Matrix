import { getAuthenticatedFetch } from "./authenticatedFetchRegistry";
import { isReauthInProgress } from "./reauthHandler";
import { unifiedApiRequest } from "./unifiedApiClient";

export async function protectedApiRequest(path, options = {}) {
  const authFetch = getAuthenticatedFetch();
  if (isReauthInProgress()) {
    const error = new Error("Reauthentication in progress");
    error.status = 401;
    throw error;
  }

  return unifiedApiRequest(authFetch, path, options);
}

export function protectedApiGet(path, options = {}) {
  return protectedApiRequest(path, { method: "GET", ...options });
}

export function protectedApiDelete(path, options = {}) {
  return protectedApiRequest(path, { method: "DELETE", ...options });
}

export function protectedApiPost(path, body, options = {}) {
  const { headers: optionHeaders = {}, ...restOptions } = options;
  return protectedApiRequest(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...optionHeaders },
    ...restOptions,
    body: body == null ? undefined : JSON.stringify(body),
  });
}

export function protectedApiPut(path, body, options = {}) {
  const { headers: optionHeaders = {}, ...restOptions } = options;
  return protectedApiRequest(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...optionHeaders },
    ...restOptions,
    body: body == null ? undefined : JSON.stringify(body),
  });
}

export function protectedApiPatch(path, body, options = {}) {
  const { headers: optionHeaders = {}, ...restOptions } = options;
  return protectedApiRequest(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...optionHeaders },
    ...restOptions,
    body: body == null ? undefined : JSON.stringify(body),
  });
}
