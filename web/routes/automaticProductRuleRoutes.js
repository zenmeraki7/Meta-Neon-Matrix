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
import {
  subscriptionMiddleware,
  requirePaidPlanMiddleware,
} from "../middleware/subscriptionMiddleware.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";

const router = express.Router();

function requireShopifyAuth(req, res, next) {
  const session = res.locals.shopify?.session;
  if (!session?.shop) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      { code: "UNAUTHENTICATED" },
      "UNAUTHENTICATED",
    );
    return res.status(statusCode).json(body);
  }
  return next();
}

const loadSubscriptionContext = subscriptionMiddleware;

function requireEntitlement(feature) {
  return (req, res, next) => {
    const entitlement = res.locals.entitlement;
    if (!entitlement) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "FORBIDDEN" },
        "FORBIDDEN",
      );
      return res.status(statusCode).json(body);
    }
    return next();
  };
}

function requireWriteCatalogPermission(req, res, next) {
  const session = res.locals.shopify?.session;
  if (!session?.shop) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      { code: "UNAUTHENTICATED" },
      "UNAUTHENTICATED",
    );
    return res.status(statusCode).json(body);
  }
  return next();
}

function requireIdempotencyKeyIfExecutionTrigger(req, res, next) {
  const key = req.get("Idempotency-Key") || req.body?.idempotencyKey;
  if (!key) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      { code: "IDEMPOTENCY_KEY_REQUIRED" },
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
  return next();
}

router.use(requireShopifyAuth);
router.use(loadSubscriptionContext);

router.get("/", listAutomaticProductRulesController);
router.get("/:id", getAutomaticProductRuleByIdController);
router.get("/:id/runs", listAutomaticProductRuleRunsController);
router.post("/", requireWriteCatalogPermission, requirePaidPlanMiddleware, requireEntitlement("AUTOMATIC_RULES"), createAutomaticProductRuleController);
router.put("/:id", requireWriteCatalogPermission, requirePaidPlanMiddleware, requireEntitlement("AUTOMATIC_RULES"), updateAutomaticProductRuleController);
router.post("/:id/pause", requireWriteCatalogPermission, requirePaidPlanMiddleware, requireEntitlement("AUTOMATIC_RULES"), pauseAutomaticProductRuleController);
router.post("/:id/resume", requireWriteCatalogPermission, requirePaidPlanMiddleware, requireEntitlement("AUTOMATIC_RULES"), resumeAutomaticProductRuleController);
router.post("/:id/run-now", requireWriteCatalogPermission, requirePaidPlanMiddleware, requireEntitlement("AUTOMATIC_RULES"), requireIdempotencyKeyIfExecutionTrigger, runAutomaticProductRuleNowController);
router.delete("/:id", requireWriteCatalogPermission, requirePaidPlanMiddleware, requireEntitlement("AUTOMATIC_RULES"), deleteAutomaticProductRuleController);

export default router;
