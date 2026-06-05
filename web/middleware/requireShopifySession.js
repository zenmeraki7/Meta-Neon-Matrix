import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";

export function requireShopifySession(req, res, next) {
  const session = res.locals?.shopify?.session;

  if (!session?.shop) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      { code: "UNAUTHENTICATED" },
      "UNAUTHENTICATED",
    );
    return res.status(statusCode).json(body);
  }

  return next();
}

