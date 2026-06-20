export function requireShop(req, res, next) {
  const shop = res.locals?.shopify?.session?.shop ?? req.shopify?.session?.shop;

  if (!shop || typeof shop !== "string") {
    return res.status(401).json({
      error: "Unauthorized shop session",
    });
  }

  req.shopDomain = shop;
  next();
}
