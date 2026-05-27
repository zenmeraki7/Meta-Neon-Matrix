import express from "express";
import {
  createAutomaticProductRuleController,
  deleteAutomaticProductRuleController,
  getAutomaticProductRuleByIdController,
  listAutomaticProductRuleRunsController,
  listAutomaticProductRulesController,
  pauseAutomaticProductRuleController,
  resumeAutomaticProductRuleController,
  runAutomaticProductRuleNowController,
  updateAutomaticProductRuleController,
} from "../controllers/automaticProductRuleController.js";
import { subscriptionMiddleware } from "../middleware/subscriptionMiddleware.js";

const router = express.Router();

function requireShopifyAuth(req, res, next) {
  const session = res.locals.shopify?.session;
  if (!session?.shop) {
    return res.status(401).json({ code: "UNAUTHENTICATED", message: "Authentication required" });
  }
  return next();
}

function requireShopContext(req, res, next) {
  const shop = res.locals.shopify?.session?.shop;
  if (!shop) {
    return res.status(401).json({ code: "SHOP_CONTEXT_REQUIRED", message: "Shop context required" });
  }
  res.locals.shop = shop;
  return next();
}

const loadSubscriptionContext = subscriptionMiddleware;

function requireEntitlement(feature) {
  return (req, res, next) => {
    const entitlement = res.locals.entitlement;
    if (!entitlement) {
      return res.status(403).json({ code: "ENTITLEMENT_REQUIRED", message: `${feature} entitlement required` });
    }
    return next();
  };
}

function requireWriteCatalogPermission(req, res, next) {
  const session = res.locals.shopify?.session;
  if (!session?.shop) {
    return res.status(401).json({ code: "UNAUTHENTICATED", message: "Authentication required" });
  }
  return next();
}

function requireIdempotencyKeyIfExecutionTrigger(req, res, next) {
  const key = req.get("Idempotency-Key") || req.body?.idempotencyKey;
  if (!key) {
    return res.status(400).json({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "Idempotency-Key is required" });
  }
  return next();
}

router.use(requireShopifyAuth);
router.use(requireShopContext);
router.use(loadSubscriptionContext);

router.get("/", listAutomaticProductRulesController);
router.get("/:id", getAutomaticProductRuleByIdController);
router.get("/:id/runs", listAutomaticProductRuleRunsController);
router.post("/", requireWriteCatalogPermission, requireEntitlement("AUTOMATIC_RULES"), createAutomaticProductRuleController);
router.put("/:id", requireWriteCatalogPermission, requireEntitlement("AUTOMATIC_RULES"), updateAutomaticProductRuleController);
router.post("/:id/pause", requireWriteCatalogPermission, requireEntitlement("AUTOMATIC_RULES"), pauseAutomaticProductRuleController);
router.post("/:id/resume", requireWriteCatalogPermission, requireEntitlement("AUTOMATIC_RULES"), resumeAutomaticProductRuleController);
router.post("/:id/run-now", requireWriteCatalogPermission, requireEntitlement("AUTOMATIC_RULES"), requireIdempotencyKeyIfExecutionTrigger, runAutomaticProductRuleNowController);
router.delete("/:id", requireWriteCatalogPermission, requireEntitlement("AUTOMATIC_RULES"), deleteAutomaticProductRuleController);

export default router;
