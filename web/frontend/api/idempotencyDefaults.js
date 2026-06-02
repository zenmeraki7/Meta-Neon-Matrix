const IDEMPOTENT_ROUTE_PREFIXES = Object.freeze([
  "/api/products/update",
  "/api/products/schedule-task",
  "/api/products/create-recurring-edit",
  "/api/products/create-scheduled-export",
  "/api/products/export",
  "/api/products/undo-edit",
  "/api/products/update-recurring-edit",
  "/api/products/delete-recurring-edit",
  "/api/products/csv/import",
  "/api/subscription/create-subscription",
  "/api/product-code-snippets",
]);

const IDEMPOTENT_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function normalizePath(path) {
  if (typeof path !== "string") {
    return "";
  }
  const qIndex = path.indexOf("?");
  return qIndex >= 0 ? path.slice(0, qIndex) : path;
}

export function shouldDefaultIdempotent(method, path) {
  const methodUpper = String(method || "GET").toUpperCase();
  if (!IDEMPOTENT_METHODS.has(methodUpper)) {
    return false;
  }

  const normalizedPath = normalizePath(path);
  return IDEMPOTENT_ROUTE_PREFIXES.some(
    (prefix) =>
      normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`),
  );
}

export { IDEMPOTENT_ROUTE_PREFIXES };
