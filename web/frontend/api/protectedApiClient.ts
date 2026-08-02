import { getAuthenticatedFetch } from "./authenticatedFetchRegistry";
import { isReauthInProgress } from "./reauthHandler";
import { unifiedApiRequest } from "./unifiedApiClient";

export interface ProtectedApiRequestOptions
  extends Omit<RequestInit, "body" | "method"> {
  idempotent?: boolean;
  idempotencyKey?: string;
}

export interface ProtectedApiErrorPayload {
  code?: string;
  message?: string;
  details?: unknown;
  [key: string]: unknown;
}

export class ProtectedApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly payload?: ProtectedApiErrorPayload;

  constructor({
    message,
    status,
    code,
    payload,
  }: {
    message: string;
    status: number;
    code?: string;
    payload?: ProtectedApiErrorPayload;
  }) {
    super(message);
    this.name = "ProtectedApiError";
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

export async function protectedApiRequest<TResponse = unknown>(
  path: string,
  options: RequestInit & { idempotent?: boolean; idempotencyKey?: string } = {},
): Promise<TResponse> {
  const authFetch = getAuthenticatedFetch();
  if (isReauthInProgress()) {
    const error = new ProtectedApiError({
      message: "Reauthentication in progress",
      status: 401,
      code: "REAUTH_IN_PROGRESS",
    });
    throw error;
  }

  return unifiedApiRequest(authFetch, path, options) as Promise<TResponse>;
}

export function protectedApiGet<TResponse = unknown>(
  path: string,
  options: ProtectedApiRequestOptions = {},
): Promise<TResponse> {
  return protectedApiRequest<TResponse>(path, { method: "GET", ...options });
}

export function protectedApiDelete<TResponse = unknown>(
  path: string,
  options: ProtectedApiRequestOptions = {},
): Promise<TResponse> {
  return protectedApiRequest<TResponse>(path, { method: "DELETE", ...options });
}

export function protectedApiPost<
  TResponse = unknown,
  TRequest extends object = Record<string, unknown>,
>(
  path: string,
  body?: TRequest,
  options: ProtectedApiRequestOptions = {},
): Promise<TResponse> {
  const { headers: optionHeaders = {}, ...restOptions } = options;
  return protectedApiRequest<TResponse>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(optionHeaders as Record<string, string>) },
    ...restOptions,
    body: body == null ? undefined : JSON.stringify(body),
  });
}

export function protectedApiPut<
  TResponse = unknown,
  TRequest extends object = Record<string, unknown>,
>(
  path: string,
  body?: TRequest,
  options: ProtectedApiRequestOptions = {},
): Promise<TResponse> {
  const { headers: optionHeaders = {}, ...restOptions } = options;
  return protectedApiRequest<TResponse>(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(optionHeaders as Record<string, string>) },
    ...restOptions,
    body: body == null ? undefined : JSON.stringify(body),
  });
}

export function protectedApiPatch<
  TResponse = unknown,
  TRequest extends object = Record<string, unknown>,
>(
  path: string,
  body?: TRequest,
  options: ProtectedApiRequestOptions = {},
): Promise<TResponse> {
  const { headers: optionHeaders = {}, ...restOptions } = options;
  return protectedApiRequest<TResponse>(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(optionHeaders as Record<string, string>) },
    ...restOptions,
    body: body == null ? undefined : JSON.stringify(body),
  });
}
