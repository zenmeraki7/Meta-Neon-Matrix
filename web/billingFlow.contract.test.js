import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(file) {
  return fs.readFileSync(path.resolve(file), "utf8");
}

test("billing subscribe endpoint is mounted and creates subscriptions server-side", () => {
  const app = read("web/app.js");
  const routes = read("web/routes/billingRoutes.js");
  const controller = read("web/controllers/billingController.js");
  const registry = read("web/services/billingPlanRegistry.js");
  const billingService = read("web/services/subscription/ShopifyBillingService.js");
  const billingMode = read("web/services/billingModeService.js");
  const legacyPlans = read("web/services/SubscriptionService/SubscriptionService.js");

  assert.ok(app.includes('app.use("/api/billing", BillingRoutes)'));
  assert.ok(routes.includes('router.post("/subscribe", subscribeBillingController)'));
  assert.ok(routes.includes('router.post("/sync", syncBillingController)'));
  assert.ok(controller.includes("res.locals.shopify?.session"));
  assert.ok(controller.includes("new ShopifyBillingService(session)"));
  assert.ok(controller.includes("confirmationUrl"));
  assert.ok(controller.includes("savePendingBillingApproval"));
  assert.ok(controller.includes("pendingSubscriptionId"));
  assert.ok(controller.includes("getActiveSubscriptions"));
  assert.ok(controller.includes("INVALID_BILLING_PLAN"));
  assert.ok(controller.includes("error?.expose === true"));
  assert.ok(registry.includes("basic"));
  assert.ok(registry.includes("pro"));
  assert.ok(registry.includes("PROFESSIONAL_MONTHLY"));
  assert.ok(legacyPlans.includes("BASIC_MONTHLY"));
  assert.ok(billingService.includes("SHOPIFY_BILLING_TEST_MODE"));
  assert.ok(billingService.includes("test: $test"));
  assert.ok(billingService.includes("Shopify appSubscriptionCreate response"));
  assert.ok(billingService.includes("userErrors"));
  assert.ok(billingService.includes("currentAppInstallation"));
  assert.ok(billingService.includes("BILLING_API_UNAVAILABLE"));
  assert.ok(
    billingService.includes("Apps without a public distribution cannot use the Billing API"),
  );
  assert.ok(billingMode.includes("DEV_BILLING_MODE=mock is not allowed in production"));
  assert.ok(billingMode.includes("SHOPIFY_BILLING_ENABLED"));
  assert.ok(billingMode.includes("createMockBillingSubscription"));
  assert.ok(billingMode.includes("MOCK_SUBSCRIPTION_ACTIVATED"));
  assert.ok(controller.includes("createMockBillingSubscription"));
  assert.ok(controller.includes('billingProvider: "MOCK"'));
});

test("pricing page uses live authenticated API hook and app bridge redirect", () => {
  const pricing = read("web/frontend/pages/Pricing.jsx");
  const locale = read("web/frontend/locales/en/subscription.json");

  assert.ok(pricing.includes("useApiClient"));
  assert.ok(pricing.includes('"/api/billing/subscribe"'));
  assert.ok(pricing.includes('"/api/billing/sync"'));
  assert.ok(pricing.includes('"/api/subscription/get-plans"'));
  assert.ok(pricing.includes("redirectRemote(data.confirmationUrl)"));
  assert.ok(pricing.includes("BILLING_PLAN_BY_PRICING_KEY"));
  assert.ok(pricing.includes('err?.payload?.code === "BILLING_API_UNAVAILABLE"'));
  assert.ok(pricing.includes("data.mock === true"));
  assert.equal(pricing.includes("protectedApiPost"), false);
  assert.equal(
    pricing.includes("Billing actions are unavailable because authenticated fetch is not initialized"),
    false,
  );
  assert.equal(
    locale.includes("Billing actions are unavailable because authenticated fetch is not initialized"),
    false,
  );
});

test("billing public errors distinguish auth and invalid plans", () => {
  const publicErrors = read("web/utils/publicApiError.js");

  assert.ok(publicErrors.includes("AUTH_REQUIRED"));
  assert.ok(publicErrors.includes("INVALID_BILLING_PLAN"));
  assert.ok(publicErrors.includes("UNKNOWN_BILLING_PLAN"));
  assert.ok(publicErrors.includes("BILLING_API_UNAVAILABLE"));
  assert.ok(publicErrors.includes("MOCK_BILLING_DISABLED"));
  assert.ok(publicErrors.includes('if (code === "AUTH_REQUIRED") return 401'));
  assert.ok(publicErrors.includes('if (code === "INVALID_BILLING_PLAN") return 400'));
  assert.ok(publicErrors.includes('if (code === "UNKNOWN_BILLING_PLAN") return 409'));
  assert.ok(publicErrors.includes('if (code === "BILLING_API_UNAVAILABLE") return 403'));
  assert.ok(publicErrors.includes('if (code === "MOCK_BILLING_DISABLED") return 403'));
});

test("subscription approval webhook is declared in Shopify app config", () => {
  const appConfig = read("shopify.app.toml");
  const privacy = read("web/privacy.js");

  assert.ok(appConfig.includes('"app_subscriptions/update"'));
  assert.ok(privacy.includes("APP_SUBSCRIPTIONS_UPDATE"));
  assert.ok(privacy.includes("pendingSubscriptionId"));
});

test("local env enables mock billing for development only", () => {
  const rootEnv = read(".env");
  const webEnv = read("web/.env");

  assert.ok(rootEnv.includes("SHOPIFY_BILLING_ENABLED=false"));
  assert.ok(rootEnv.includes("DEV_BILLING_MODE=mock"));
  assert.ok(webEnv.includes("SHOPIFY_BILLING_ENABLED=false"));
  assert.ok(webEnv.includes("DEV_BILLING_MODE=mock"));
});

test("paid feature entitlements accept active paid mock subscriptions", () => {
  const scheduled = read("web/services/entitlement/scheduledEditEntitlement.js");
  const recurring = read("web/services/recurringEditPlanService.js");

  assert.ok(scheduled.includes('"BASIC_MONTHLY"'));
  assert.ok(recurring.includes("RECURRING_EDIT_PLAN_KEYS"));
  assert.ok(recurring.includes('"BASIC_MONTHLY"'));
  assert.ok(recurring.includes("resolveBillingPlan"));
  assert.ok(recurring.includes('requiredPlan: "paid"'));
  assert.ok(recurring.includes('subscription?.status === "ACTIVE"'));
});
