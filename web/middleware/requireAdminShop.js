import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";

function parseAdminAllowlist() {
  return String(process.env.ADMIN_SHOP_ALLOWLIST || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export function requireAdminShop(req, res, next) {
  const session = res.locals?.shopify?.session;
  const shop = String(session?.shop || "").trim().toLowerCase();
  const allowlist = parseAdminAllowlist();

  if (!shop) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      { code: "UNAUTHENTICATED" },
      "UNAUTHENTICATED",
    );
    return res.status(statusCode).json(body);
  }

  if (!allowlist.includes(shop)) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      { code: "FORBIDDEN" },
      "FORBIDDEN",
    );
    return res.status(statusCode).json(body);
  }

  return next();
}

export default requireAdminShop;
