const KB = 1024;

export const RESPONSE_BUDGET_BYTES = Object.freeze({
  "/api/products/get-all": 72 * KB,
  "/api/products/edit-preview": 96 * KB,
  "/api/history/get-shop-edithistory": 80 * KB,
  "/api/history/get-edit-history-summary/:id": 20 * KB,
  "/api/history/get-edit-history-details/:id": 56 * KB,
  "/api/history/get-edit-history/changes/:id": 96 * KB,
  "/api/history/get-shop-importhistory": 32 * KB,
  "/api/history/export/list-summary": 24 * KB,
  "/api/history/export/detail/:id": 16 * KB,
  "/api/products/recurring/list-summary": 24 * KB,
  "/api/products/recurring/detail/:id": 20 * KB,
  "/api/sync/sync-status": 16 * KB,
  "/api/sync/sync-status/summary": 8 * KB,
  "/api/sync/sync-status/detail": 16 * KB,
  "/api/sync/product-track": 8 * KB,
  "/api/store/details": 12 * KB,
});

const ROUTE_MATCHERS = Object.entries(RESPONSE_BUDGET_BYTES).map(
  ([pattern, budgetBytes]) => {
    const regex = new RegExp(
      `^${pattern
        .split("/")
        .map((segment) => {
          if (segment.startsWith(":")) return "[^/]+";
          return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("/")}$`,
    );
    return { pattern, regex, budgetBytes };
  },
);

export function computeJsonResponseSizeBytes(body) {
  return Buffer.byteLength(JSON.stringify(body ?? null), "utf8");
}

export function matchResponseBudget(pathname = "") {
  return (
    ROUTE_MATCHERS.find((entry) => entry.regex.test(String(pathname))) || null
  );
}

export function createResponseBudgetMiddleware({
  enforce = process.env.ENFORCE_RESPONSE_BUDGETS === "true" ||
    process.env.NODE_ENV === "test",
} = {}) {
  return function responseBudgetMiddleware(req, res, next) {
    const matched = matchResponseBudget(req.path || req.originalUrl || "");
    if (!matched) {
      return next();
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const sizeBytes = computeJsonResponseSizeBytes(body);
      res.setHeader("X-Response-Size-Bytes", String(sizeBytes));
      res.setHeader("X-Response-Budget-Bytes", String(matched.budgetBytes));
      res.setHeader("X-Response-Budget-Route", matched.pattern);

      if (sizeBytes > matched.budgetBytes && enforce) {
        res.status(500);
        return originalJson({
          success: false,
          code: "RESPONSE_BUDGET_EXCEEDED",
          message: `Response exceeded budget for ${matched.pattern}`,
          meta: {
            route: matched.pattern,
            budgetBytes: matched.budgetBytes,
            actualBytes: sizeBytes,
          },
        });
      }

      return originalJson(body);
    };

    return next();
  };
}
