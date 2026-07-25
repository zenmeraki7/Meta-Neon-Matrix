const NUMERIC_STRING = /^\d+$/;

function badRequest(code, message, fields = []) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  error.fields = fields;
  return error;
}

export function normalizeSessionRouteContext(params = {}, locals = {}) {
  const shopDomain = String(locals.shop || "").trim();
  const sessionId = String(params.id || "").trim();
  if (!shopDomain || !sessionId) {
    const error = new Error("Session not found");
    error.code = "SESSION_NOT_FOUND";
    error.statusCode = 404;
    throw error;
  }
  return Object.freeze({ shopDomain, sessionId });
}

export function normalizeStageChangesBody(body = {}) {
  const changes = Array.isArray(body?.changes)
    ? body.changes
    : Array.isArray(body?.cells)
      ? body.cells
      : null;
  if (!changes || changes.length === 0 || changes.length > 1000) {
    throw badRequest("VALIDATION_FAILED", "Validation failed", [
      { field: "changes", error: "must be a non-empty array with max 1000 items" },
    ]);
  }
  for (const item of changes) {
    const variantIdRaw = String(item?.variantId || "").trim();
    const namespace = String(item?.namespace || "").trim();
    const key = String(item?.key || "").trim();
    if (!variantIdRaw || !NUMERIC_STRING.test(variantIdRaw) || !namespace || !key) {
      throw badRequest("VALIDATION_FAILED", "Validation failed", [
        { field: "changes", error: "invalid change item shape" },
      ]);
    }
  }
  return Object.freeze({ changes });
}

export function normalizeColumnApplyBody(body = {}) {
  const namespace = String(body?.namespace || "").trim();
  const key = String(body?.key || "").trim();
  const value = body?.value == null ? null : String(body.value);
  const variantIds = Array.isArray(body?.variantIds) ? body.variantIds : [];

  if (!namespace || !key || variantIds.length === 0) {
    throw badRequest("VALIDATION_FAILED", "Validation failed", [
      { field: "namespace/key/variantIds", error: "namespace, key and non-empty variantIds are required" },
    ]);
  }

  const invalidVariantId = variantIds.find((id) => !NUMERIC_STRING.test(String(id || "")));
  if (invalidVariantId) {
    throw badRequest("VALIDATION_FAILED", "Validation failed", [
      { field: "variantIds", error: "all variantIds must be numeric strings" },
    ]);
  }

  return Object.freeze({ namespace, key, value, variantIds });
}
