import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";

export function createPublicApiErrorMiddleware({ logger }) {
  if (!logger || typeof logger.error !== "function") {
    throw new Error("LOGGER_REQUIRED");
  }

  return function publicApiErrorMiddleware(err, req, res, _next) {
    const fallbackCode = String(err?.code || "INTERNAL_ERROR").toUpperCase();
    const { statusCode, body } = buildPublicApiErrorResponse(err, fallbackCode);

    logger.error("Unhandled API error", {
      code: err?.code || null,
      statusCode,
      path: req?.path || null,
      method: req?.method || null,
      requestId: req?.id || req?.headers?.["x-request-id"] || null,
      error: err?.message || null,
    });

    return res.status(statusCode).json(body);
  };
}

export default createPublicApiErrorMiddleware;
