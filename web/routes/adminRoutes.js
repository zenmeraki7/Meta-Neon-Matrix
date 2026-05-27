import express from "express";
import * as adminController from "../controllers/adminController.js";
import { requireAdminShop } from "../middleware/requireAdminShop.js";
import { requireAdminRecoveryScope } from "../middleware/requireAdminRecoveryScope.js";
import { adminSensitiveActionGuard } from "../middleware/adminSensitiveActionGuard.js";

const router = express.Router();
router.use(requireAdminShop);

// Dashboard
router.get("/dashboard", adminController.getDashboard);

// Store Routes
router.get("/stores/stats", adminController.getStoreStats);
router.get("/stores", adminController.getAllStores);
router.get("/stores/:shopUrl", adminController.getStoreDetails);

// Edit History Routes
router.get("/edit-history/stats", adminController.getEditHistoryStats);
router.get("/edit-history", adminController.getEditHistoryList);
router.get("/edit-history/failed", adminController.getFailedEdits);
router.post(
  "/edit-history/:id/recover",
  adminSensitiveActionGuard,
  requireAdminRecoveryScope,
  adminController.recoverStuckBulkEditOperation,
);

// Sync History Routes
router.get("/sync-history/stats", adminController.getSyncHistoryStats);
router.get("/sync-history", adminController.getSyncHistoryList);

export default router;
