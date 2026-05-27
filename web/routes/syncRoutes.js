import express from "express";
import {
  syncProductData,
  getSyncStatus,
  getSyncStatusSummary,
  getSyncStatusDetail,
  trackProductSync,
} from "../controllers/syncController.js";

const router = express.Router();

router.get("/products", syncProductData);
router.get("/sync-status", getSyncStatus);
router.get("/sync-status/summary", getSyncStatusSummary);
router.get("/sync-status/detail", getSyncStatusDetail);
router.get("/product-track", trackProductSync);

export default router;
