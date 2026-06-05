import express from "express";
import {
  getDashboardBootstrap,
  getProductsBootstrap,
} from "../controllers/bootstrapController.js";
import { attachStoreAccessDependencies } from "../middleware/attachStoreAccessDependencies.js";
import { requireShopifySession } from "../middleware/requireShopifySession.js";

const router = express.Router();

router.get(
  "/products",
  requireShopifySession,
  attachStoreAccessDependencies,
  getProductsBootstrap,
);
router.get(
  "/dashboard",
  requireShopifySession,
  attachStoreAccessDependencies,
  getDashboardBootstrap,
);

export default router;
