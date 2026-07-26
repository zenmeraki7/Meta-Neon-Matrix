// web/middleware/rateLimitMiddleware.js

import { normalizeShopDomain } from "../utils/shopDomainUtils.js";

const rateLimitStores = new Map();

function getShopKey(req, res) {
  const shopFromRes = res?.locals?.shopify?.session?.shop;
  const shopFromQuery = req.query?.shop;
  const shopFromHeader = req.headers?.["x-shopify-shop-domain"];
  const rawShop = shopFromRes || shopFromQuery || shopFromHeader;
  return normalizeShopDomain(rawShop) || req.ip || "global";
}

export function createPerShopRateLimit({
  windowMs = 60_000,
  maxRequests = 100,
  message = "Rate limit exceeded. Please try again later.",
  errorCode = "RATE_LIMITED",
} = {}) {
  const store = new Map();

  // Periodic cleanup
  setInterval(() => {
    const now = Date.now();
    for (const [key, record] of store.entries()) {
      if (now > record.resetTime) {
        store.delete(key);
      }
    }
  }, Math.max(windowMs, 30_000)).unref();

  return function perShopRateLimitMiddleware(req, res, next) {
    const shopKey = getShopKey(req, res);
    const now = Date.now();

    let record = store.get(shopKey);
    if (!record || now > record.resetTime) {
      record = {
        count: 0,
        resetTime: now + windowMs,
      };
      store.set(shopKey, record);
    }

    record.count += 1;

    res.setHeader("X-RateLimit-Limit", maxRequests);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, maxRequests - record.count));
    res.setHeader("X-RateLimit-Reset", Math.ceil(record.resetTime / 1000));

    if (record.count > maxRequests) {
      const error = new Error(message);
      error.code = errorCode;
      error.status = 429;
      res.setHeader("Retry-After", Math.ceil((record.resetTime - now) / 1000));
      return next(error);
    }

    return next();
  };
}

export const defaultPerShopRateLimit = createPerShopRateLimit({
  windowMs: 60_000,
  maxRequests: 100,
  message: "Per-shop rate limit exceeded. Please slow down.",
});

export const strictLiveLookupRateLimit = createPerShopRateLimit({
  windowMs: 60_000,
  maxRequests: 20,
  message: "Live lookup rate limit exceeded. Please try again in a minute.",
});

export const strictRefreshRateLimit = createPerShopRateLimit({
  windowMs: 300_000,
  maxRequests: 5,
  message: "Refresh rate limit exceeded. Please wait 5 minutes before trying again.",
});
