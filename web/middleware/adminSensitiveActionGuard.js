import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";

function normalizeHost(value = "") {
  return String(value || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function parseAllowedHosts() {
  const hosts = new Set();
  const appUrl = String(process.env.SHOPIFY_APP_URL || process.env.APP_URL || "").trim();
  if (appUrl) {
    try {
      hosts.add(normalizeHost(new URL(appUrl).host));
    } catch {
      hosts.add(normalizeHost(appUrl));
    }
  }
  for (const raw of String(process.env.ADMIN_ALLOWED_ORIGINS || "").split(",")) {
    const entry = String(raw || "").trim();
    if (!entry) continue;
    try {
      hosts.add(normalizeHost(new URL(entry).host));
    } catch {
      hosts.add(normalizeHost(entry));
    }
  }
  return hosts;
}

export function adminSensitiveActionGuard(req, res, next) {
  const requestedWith = String(req.get("x-requested-with") || "").trim().toLowerCase();
  const origin = String(req.get("origin") || "").trim();
  const allowedHosts = parseAllowedHosts();
  const originHost = origin ? normalizeHost(new URL(origin).host) : "";

  if (requestedWith !== "xmlhttprequest") {
    const { statusCode, body } = buildPublicApiErrorResponse(
      { code: "FORBIDDEN" },
      "FORBIDDEN",
    );
    return res.status(statusCode).json(body);
  }

  if (origin && allowedHosts.size > 0 && !allowedHosts.has(originHost)) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      { code: "FORBIDDEN" },
      "FORBIDDEN",
    );
    return res.status(statusCode).json(body);
  }

  return next();
}

export default adminSensitiveActionGuard;
