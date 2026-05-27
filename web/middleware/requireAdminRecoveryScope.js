import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";

function parseScopes(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function requireAdminRecoveryScope(req, res, next) {
  const required = String(process.env.ADMIN_RECOVERY_REQUIRED_SCOPE || "bulk_edit_recovery")
    .trim()
    .toLowerCase();
  const providedScopes = new Set([
    ...parseScopes(req.get("x-admin-scope")),
    ...parseScopes(req.get("x-admin-scopes")),
  ]);

  if (!providedScopes.has(required)) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      { code: "FORBIDDEN" },
      "FORBIDDEN",
    );
    return res.status(statusCode).json(body);
  }

  return next();
}

export default requireAdminRecoveryScope;
