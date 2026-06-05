import express from "express";
import {
  syncProductData,
  getSyncStatus,
  getSyncStatusSummary,
  trackProductSync,
} from "../controllers/syncController.js";
import { attachSyncStatusDependencies } from "../middleware/attachSyncStatusDependencies.js";
import { requireShopifySession } from "../middleware/requireShopifySession.js";
import { subscriptionMiddleware } from "../middleware/subscriptionMiddleware.js";

const router = express.Router();

router.get("/products", requireShopifySession, subscriptionMiddleware, syncProductData);
router.get("/sync-status", requireShopifySession, getSyncStatus);
router.get("/sync-status/summary", requireShopifySession, getSyncStatusSummary);
router.get("/sync-status/detail", requireShopifySession, getSyncStatus);
router.get(
  "/product-track",
  requireShopifySession,
  attachSyncStatusDependencies,
  trackProductSync,
);

export default router;
