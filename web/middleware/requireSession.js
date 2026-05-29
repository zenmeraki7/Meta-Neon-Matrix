import shopify from "../shopify.js";

const validateSession = shopify.validateAuthenticatedSession();

/**
 * Validates Shopify session and exposes shop on res.locals.shop.
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 * @returns {void}
 */
export default function requireSession(req, res, next) {
  validateSession(req, res, (err) => {
    if (err) {
      next(err);
      return;
    }
    res.locals.shop = res.locals?.shopify?.session?.shop || null;
    next();
  });
}

