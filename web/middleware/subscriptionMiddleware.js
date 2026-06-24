//web/middleware/subscriptionMiddleware.js

import { PLANS } from "../services/SubscriptionService/SubscriptionService.js";

import { db } from "../repositories/repositoryDb.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";


export const subscriptionMiddleware = async (req, res, next) => {
  try {
    // Get shop from session 
    const session = res.locals.shopify?.session;
    
    if (!session || !session.shop) {
      console.error("[SUBSCRIPTION_MIDDLEWARE] No session or shop found");
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }

    const shop = session.shop;
    console.log("[SUBSCRIPTION_MIDDLEWARE] Checking subscription for shop:", shop);


    // Check if store has free credit (grandfathered access)
const store = await db.store.findUnique({
      where: { shopUrl: shop },
      select: { isCreditAvailable: true },
    });

    // If store has isCreditAvailable = true, grant them Pro plan access for free
    if (store && store.isCreditAvailable === true) {
      console.log("[SUBSCRIPTION_MIDDLEWARE] Store has free credit - granting Pro access");
      
      req.subscription = {
        shop,
        planKey: "PRO_MONTHLY",
        planName: "Pro Plan (Grandfathered)",
        limit: Infinity,
        isUnlimited: true,
        status: "ACTIVE",
        subscriptionId: null,
        isCreditUser: true, // Flag to indicate this is a grandfathered user
      };
      res.locals.entitlement = {
        ...req.subscription,
        source: "subscriptionMiddleware",
      };

      console.log("[SUBSCRIPTION_MIDDLEWARE] Subscription info (Credit User):", req.subscription);
      return next();
    }

      // 🔍 Find subscription using shop
    const subscription = await db.subscription.findFirst({
      where: { shop },
    });

    // Determine limit based on subscription
    let limit = 100; // Default for FREE or no subscription
    let planKey = "FREE";
    let planName = "Free Plan";

    if (subscription && subscription.planKey) {
      planKey = subscription.planKey;
      const plan = PLANS[planKey];

      if (plan) {
        planName = plan.name;

        // Only apply plan limits if subscription is ACTIVE
        if (subscription.status === "ACTIVE" || subscription.status === "PENDING") {
          // Check plan keys that match your PLANS object
          if (planKey === "ADVANCED_MONTHLY") {
            limit = 1000;
          } else if (planKey === "PRO_MONTHLY") {
            limit = Infinity; // Unlimited
          } else {
            limit = 100; // FREE or unknown
          }
        } else {
          // If status is CANCELLED, or FREE, default to 100
          limit = 100;
        }
      }
    }

    // Attach subscription info to request for use in controllers
    req.subscription = {
      shop,
      planKey,
      planName,
      limit,
      isUnlimited: limit === Infinity,
      status: subscription?.status || "FREE",
      subscriptionId: subscription?.subscriptionId || null,
      isCreditUser : false
    };
    res.locals.entitlement = {
      ...req.subscription,
      source: "subscriptionMiddleware",
    };

    console.log("[SUBSCRIPTION_MIDDLEWARE] Subscription info:", req.subscription);

    // Continue to next middleware/controller
    next();

  } catch (error) {
    console.error("[SUBSCRIPTION_MIDDLEWARE] Error:", error);
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
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

