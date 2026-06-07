import { generateErrorId } from "./errorUtils.js";
import logger from "./loggerUtils.js";
import { errorResponse } from "./responseUtils.js";

const ERROR_TYPE_BY_STATUS = Object.freeze({
  400: "VALIDATION",
  401: "AUTH",
  403: "PERMISSION",
  404: "NOT_FOUND",
  409: "CONFLICT",
  422: "VALIDATION",
  429: "RATE_LIMIT",
  503: "UNAVAILABLE",
});

export function errorTypeForStatus(statusCode) {
  return ERROR_TYPE_BY_STATUS[statusCode]
    || (statusCode >= 500 ? "SERVER_ERROR" : "UNKNOWN");
}

/**
 * Wraps controller functions to handle async errors uniformly
 * @param {Function} fn - The async controller function to wrap
 * @returns {Function} Express middleware function that handles errors
 */
export const asyncHandler = (fn) => {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      const errorId = generateErrorId();

      const requestedStatusCode = Number(err?.statusCode);
      const statusCode =
        Number.isInteger(requestedStatusCode)
        && requestedStatusCode >= 400
        && requestedStatusCode <= 599
          ? requestedStatusCode
          : 500;
      const userMessage = err.userMessage || "An unexpected error occurred. Please try again later.";
      const errorData = process.env.NODE_ENV === "development"
        ? { details: err.message, id: errorId }
        : { id: errorId };

      logger.error({
        errorId,
        message: err.message,
        stack: err.stack,
        statusCode,
        path: req.originalUrl,
        method: req.method,
        shop: res.locals?.shopify?.session?.shop || "unknown-shop",
      });

      const response = errorResponse(userMessage, errorData);
      response.type = err.type || errorTypeForStatus(statusCode);
      if (err.retryable !== undefined) {
        response.retryable = Boolean(err.retryable);
      }

      res.status(statusCode).json(response);
    }
  };
};
