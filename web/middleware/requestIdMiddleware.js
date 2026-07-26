import crypto from "crypto";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._~:/+-]{1,128}$/;

/**
 * Server middleware ensuring res.locals.requestId is generated or validated.
 * Incoming client request IDs are validated for format and length limits before use;
 * invalid or missing IDs fall back to a server-generated UUID.
 */
export function requestIdMiddleware(req, res, next) {
  const incoming =
    req.headers?.["x-request-id"] || req.headers?.["x-correlation-id"];

  if (typeof incoming === "string") {
    const trimmed = incoming.trim();
    if (REQUEST_ID_PATTERN.test(trimmed)) {
      res.locals.requestId = trimmed;
      res.setHeader("X-Request-ID", trimmed);
      return next();
    }
  }

  const generatedId = `req_${crypto.randomUUID()}`;
  res.locals.requestId = generatedId;
  res.setHeader("X-Request-ID", generatedId);
  return next();
}
