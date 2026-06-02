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

const collectionService = new CollectionService(shopify);

const router = express.Router();
router.get("/get-all", listCollections(collectionService));
router.get("/options", listCollectionOptions(collectionService));
router.get("/live", subscriptionMiddleware, listLiveCollections(collectionService));
router.post("/refresh", subscriptionMiddleware, requestCollectionRefresh(collectionService));
router.post("/collections-refresh", subscriptionMiddleware, requestCollectionRefresh(collectionService));

export default router;
