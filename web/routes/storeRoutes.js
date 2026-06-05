import express from "express";
import {
  getStoreAccess,
} from "../controllers/storeController.js";
import { attachStoreAccessDependencies } from "../middleware/attachStoreAccessDependencies.js";
import { requireShopifySession } from "../middleware/requireShopifySession.js";

const router = express.Router();
router.get(
  "/details",
  requireShopifySession,
  attachStoreAccessDependencies,
  getStoreAccess,
);

export default router;
