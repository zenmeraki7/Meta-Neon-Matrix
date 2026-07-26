// web/routes/collectionRoutes.js
import express from "express";
import {
  listCollections,
  listCollectionOptions,
  listLiveCollections,
  requestCollectionRefresh,
} from "../controllers/collectionController.js";
import { CollectionService } from "../services/collectionService/CollectionService.js";
import shopify from "../shopify.js";
import { subscriptionMiddleware } from "../middleware/subscriptionMiddleware.js";
import { requestIdMiddleware } from "../middleware/requestIdMiddleware.js";
import {
  defaultPerShopRateLimit,
  strictLiveLookupRateLimit,
  strictRefreshRateLimit,
} from "../middleware/rateLimitMiddleware.js";

const collectionService = new CollectionService(shopify);
const authenticateShopify = shopify.validateAuthenticatedSession();

const router = express.Router();

router.use(requestIdMiddleware);
router.use(express.json({ limit: "64kb", strict: true }));
router.use(express.urlencoded({ extended: false, limit: "64kb", parameterLimit: 100 }));

router.get(
  "/get-all",
  authenticateShopify,
  defaultPerShopRateLimit,
  listCollections(collectionService),
);

router.get(
  "/options",
  authenticateShopify,
  defaultPerShopRateLimit,
  listCollectionOptions(collectionService),
);

router.get(
  "/live",
  authenticateShopify,
  subscriptionMiddleware,
  strictLiveLookupRateLimit,
  listLiveCollections(collectionService),
);

router.post(
  "/refresh",
  authenticateShopify,
  subscriptionMiddleware,
  strictRefreshRateLimit,
  requestCollectionRefresh(collectionService),
);

router.post(
  "/collections-refresh",
  authenticateShopify,
  subscriptionMiddleware,
  strictRefreshRateLimit,
  requestCollectionRefresh(collectionService),
);

export default router;
