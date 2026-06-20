import express from "express";

declare global {
  namespace Express {
    interface Request {
      shopify?: { session?: { shop?: string } };
      shopDomain?: string;
    }
  }
}

export function requireShop(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const shop = res.locals?.shopify?.session?.shop ?? req.shopify?.session?.shop;

  if (!shop || typeof shop !== "string") {
    return res.status(401).json({
      error: "Unauthorized shop session",
    });
  }

  req.shopDomain = shop;

  next();
}
