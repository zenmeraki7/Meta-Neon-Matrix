import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";
import { loadAuthoritativeSubscriptionForShop } from "../services/subscriptionAuthorityService.js";
import {
  buildScheduleEditCapability,
  SCHEDULED_EDITS_FEATURE,
  SCHEDULED_EDITS_UPGRADE_MESSAGE,
} from "../services/entitlement/scheduledEditEntitlement.js";


export const subscriptionMiddleware = async (req, res, next) => {
  try {
    const session = res.locals.shopify?.session;

    if (!session?.shop) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }

    req.subscription = await loadAuthoritativeSubscriptionForShop(session.shop);
    res.locals.entitlement = {
      ...req.subscription,
      source: "subscriptionMiddleware",
    };

    return next();
  } catch (error) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      error?.code || "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
};
export const requirePaidPlanMiddleware = (req, res, next) => {
  try {
    if (!req.subscription) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "INTERNAL_ERROR" },
        "INTERNAL_ERROR",
      );
      return res.status(statusCode).json(body);
    }
    
    const { planKey, status,isCreditUser } = req.subscription;
    
     // Allow credit users (grandfathered users) to access paid features
    if (isCreditUser === true) {
      console.log("[REQUIRE_PAID_PLAN] Credit user detected - allowing access");
      return next();
    }

    // Block FREE plan
    if (planKey === "FREE") {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UPGRADE_REQUIRED" },
        "UPGRADE_REQUIRED",
      );
      return res.status(statusCode).json(body);
    }

    // Optional: Also ensure subscription is ACTIVE
    if (status !== "ACTIVE") {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UPGRADE_REQUIRED" },
        "UPGRADE_REQUIRED",
      );
      return res.status(statusCode).json(body);
    }

    next();
  } catch (error) {
    console.error("[REQUIRE_PAID_PLAN] Error:", error);
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
};

export const requireScheduledEditPlanMiddleware = (req, res, next) => {
  try {
    if (!req.subscription) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "INTERNAL_ERROR" },
        "INTERNAL_ERROR",
      );
      return res.status(statusCode).json(body);
    }

    const capability = buildScheduleEditCapability(req.subscription);
    if (!capability.canScheduleEdits) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        {
          code: "UPGRADE_REQUIRED",
          message: SCHEDULED_EDITS_UPGRADE_MESSAGE,
          details: {
            feature: SCHEDULED_EDITS_FEATURE,
            upgradeRequired: true,
            billingUrl: capability.billingUrl,
          },
        },
        "UPGRADE_REQUIRED",
      );
      return res.status(statusCode).json(body);
    }

    next();
  } catch (error) {
    console.error("[REQUIRE_SCHEDULED_EDIT_PLAN] Error:", error);
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
};

