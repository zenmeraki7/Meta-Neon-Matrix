import express from "express";
import {
  syncProductData,
  getSyncStatus,
  getSyncStatusSummary,
  getSyncStatusDetail,
  trackProductSync,
} from "../controllers/syncController.js";
import { subscriptionMiddleware } from "../middleware/subscriptionMiddleware.js";

const router = express.Router();

router.get("/products", subscriptionMiddleware, syncProductData);
router.get("/sync-status", getSyncStatus);
router.get("/sync-status/summary", getSyncStatusSummary);
router.get("/sync-status/detail", getSyncStatusDetail);
router.get("/product-track", trackProductSync);

export default router;
