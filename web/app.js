// app.js
import { join } from "path";
import { readFileSync } from "fs";
import express from "express";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import serveStatic from "serve-static";
import cors from "cors";

// Shopify
import shopify from "./shopify.js";
import PrivacyWebhookHandlers from "./privacy.js";

// Routes
import productRoutes from "./routes/productRoutes.js";
import collectionRoutes from "./routes/collectionRoutes.js";
import SubscriptionRoutes from "./routes/SubscriptionRoutes.js";
import SuggestionRoutes from "./routes/SuggestionRoutes.js";
import HistoryRoutes from "./routes/HistoryRoutes.js";
import StoreRoutes from "./routes/storeRoutes.js";
import SyncRoutes from "./routes/syncRoutes.js";
import AffiliateRoutes from "./routes/affiliateRoutes.js";
import LocationRoutes from "./routes/locationRoutes.js";
import intelligenceRoutes from "./routes/intelligenceRoutes.js";
import AdminRoutes from "./routes/adminRoutes.js";
import metricsRoute from "./routes/metricsRoute.js";

// Socket
import { initSocket } from "./socket.js";
import logger from "./utils/loggerUtils.js";
import {
  appInstallMiddleware,
  shopPreInstallation,
} from "./middleware/appInstallMiddleware.js";
import { createResponseBudgetMiddleware } from "./middleware/responseBudgetMiddleware.js";

const STATIC_PATH =
  process.env.NODE_ENV === "production"
    ? `${process.cwd()}/frontend/dist`
    : `${process.cwd()}/frontend/`;

function requireValidShopForAuth(req, res, next) {
  const shop = normalizeShop(req.query.shop) || shopFromHost(req.query.host);

  if (shop && shop !== req.query.shop) {
    const nextUrl = new URL(req.originalUrl, `${req.protocol}://${req.get("host")}`);
    nextUrl.searchParams.set("shop", shop);
    return res.redirect(nextUrl.pathname + nextUrl.search);
  }

  if (!shop) {
    return res.status(400).send(`
      <h2>Missing Shopify shop</h2>
      <p>Open this app from Shopify Admin, not directly from the Cloudflare URL.</p>
    `);
  }

  return next();
}

function normalizeShop(shop) {
  if (!shop || shop === "undefined" || typeof shop !== "string") {
    return null;
  }

  return shop.endsWith(".myshopify.com") ? shop : null;
}

function shopFromHost(host) {
  if (!host || host === "undefined" || typeof host !== "string") {
    return null;
  }

  try {
    const normalizedHost = host.replace(/-/g, "+").replace(/_/g, "/");
    const decodedHost = Buffer.from(normalizedHost, "base64").toString("utf8");
    const storeHandle = decodedHost.match(/admin\.shopify\.com\/store\/([^/?#]+)/)?.[1];

    return storeHandle ? `${storeHandle}.myshopify.com` : null;
  } catch {
    return null;
  }
}

function rejectMissingApiAuthorization(req, res, next) {
  if (req.method === "OPTIONS") {
    return next();
  }

  if (!req.get("authorization")) {
    return res.status(401).json({
      error:
        "Missing Shopify Authorization header. Reload the embedded app from Shopify Admin.",
      code: "SHOPIFY_AUTHORIZATION_MISSING",
    });
  }

  return next();
}

export const buildApp = (_server, io) => {
  const app = express();

  // Security
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: { policy: "same-origin" },
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );

  app.use(cors());
  app.set("trust proxy", 1);
  app.use(shopify.cspHeaders());

  // Socket
  initSocket(io);

  // Auth
  app.get(
    shopify.config.auth.path,
    requireValidShopForAuth,
    shopPreInstallation,
    shopify.auth.begin(),
  );

  app.get(
    shopify.config.auth.callbackPath,
    shopify.auth.callback(),
    appInstallMiddleware,
    shopify.redirectToShopifyOrAppRoot(),
  );

  // Webhooks must be registered before express.json()
  app.post(
    shopify.config.webhooks.path,
    shopify.processWebhooks({ webhookHandlers: PrivacyWebhookHandlers }),
  );

  // Normal API body parser after webhooks
  app.use(express.json({ limit: "300kb" }));
  app.use(compression({ threshold: 1024 }));

  if (process.env.NODE_ENV !== "production") {
    app.use(
      "/api",
      serveStatic(join(STATIC_PATH, "api"), {
        index: false,
        extensions: ["js", "jsx", "ts", "tsx"],
        maxAge: 0,
      }),
    );
  }

  // Protected Shopify API routes
  app.use("/api/*", rejectMissingApiAuthorization);
  app.use("/api/*", shopify.validateAuthenticatedSession());

  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.use("/api", apiLimiter);
  app.use("/api", createResponseBudgetMiddleware());

  // Routes
  app.use("/api/products", productRoutes);
  app.use("/api/collection", collectionRoutes);
  app.use("/api/suggestion", SuggestionRoutes);
  app.use("/api/subscription", SubscriptionRoutes);
  app.use("/api/history", HistoryRoutes);
  app.use("/api/store", StoreRoutes);
  app.use("/api/location", LocationRoutes);
  app.use("/api/sync", SyncRoutes);
  app.use("/api/intelligence", intelligenceRoutes);
  app.use("/api/admin", AdminRoutes);
  app.use("/metrics", metricsRoute);
  app.use("/referral", AffiliateRoutes);

  // Frontend
  app.use(
    serveStatic(STATIC_PATH, {
      index: false,
      maxAge: "1y",
      immutable: true,
    }),
  );

  const rawIndex = readFileSync(join(STATIC_PATH, "index.html"), "utf-8");
  const indexHTML = rawIndex.replace(
    "%VITE_SHOPIFY_API_KEY%",
    process.env.SHOPIFY_API_KEY,
  );

  app.get("/*", shopify.ensureInstalledOnShop(), (_req, res) =>
    res.status(200).type("html").send(indexHTML),
  );

  // Error handler
  app.use((err, req, res, _next) => {
    logger.error({
      err,
      path: req.path,
    });

    res.status(err.status || 500).json({
      error: err.message || "Internal Server Error",
    });
  });

  return app;
};
