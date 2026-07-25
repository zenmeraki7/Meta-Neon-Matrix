import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { db } from "../../repositories/repositoryDb.js";
import { PLANS } from "../../services/SubscriptionService/SubscriptionService.js";
import { getSession } from "../../utils/sessionHandler.js";
import ShopifyBillingService from "../../services/subscription/ShopifyBillingService.js";

const QUEUE_NAME = process.env.SUBSCRIPTION_BILLING_QUEUE || "subscription-billing";
const COMMAND_TYPE = "subscription_command";

function parseValue(value) {
  return value && typeof value === "object" ? value : {};
}

const subscriptionBillingWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { commandId, shop } = job.data || {};
    if (!commandId || !shop) throw new Error("MISSING_COMMAND_DATA");

    const commandRow = await db.filterTrack.findFirst({
      where: { id: commandId, shop, filterTrackType: COMMAND_TYPE },
    });
    if (!commandRow) throw new Error("SUBSCRIPTION_COMMAND_NOT_FOUND");

    const commandValue = parseValue(commandRow.value);
    if (["COMPLETED", "FAILED"].includes(String(commandValue.status || "").toUpperCase())) {
      return { skipped: true, reason: "already_terminal", commandId };
    }

    const planKey = String(commandValue.planKey || "").trim();
    const plan = PLANS[planKey];
    if (!plan) throw new Error("INVALID_PLAN_SELECTED");

    const session = await getSession(shop);
    if (!session?.shop || session.shop !== shop) throw new Error("SHOP_SESSION_NOT_AVAILABLE");
    const billingService = new ShopifyBillingService(session);

    if (plan.isFree) {
      const existingSub = await db.subscription.findFirst({ where: { shop } });
      if (existingSub?.subscriptionId && existingSub.status === "ACTIVE") {
        await billingService.cancelSubscription(existingSub.subscriptionId);
      }
      if (existingSub) {
        await db.subscription.update({
          where: { id: existingSub.id },
          data: {
            status: "FREE",
            planKey: "FREE",
            planName: "Free Plan",
            subscriptionId: null,
            currentPeriodEnd: null,
            trialEndsAt: null,
            pendingSubscriptionId: null,
            pendingPlanKey: null,
            pendingPlanName: null,
          },
        });
      } else {
        await db.subscription.create({
          data: {
            shop,
            status: "FREE",
            planKey: "FREE",
            planName: "Free Plan",
          },
        });
      }
      await db.filterTrack.update({
        where: { id: commandRow.id },
        data: { value: { ...commandValue, status: "COMPLETED", confirmationUrl: null } },
      });
      return { success: true, commandId, status: "COMPLETED", confirmationUrl: null };
    }

    const returnUrlToUse =
      commandValue.returnUrl
      || `https://${shop}/admin/apps/${process.env.SHOPIFY_API_KEY}/pricing`;
    const payload = await billingService.createSubscription({
      name: plan.name,
      returnUrl: returnUrlToUse,
      trialDays: plan.trialDays,
      price: plan.price,
    });

    const existingSub = await db.subscription.findFirst({
      where: { shop },
      orderBy: { createdAt: "desc" },
    });
    if (existingSub) {
      await db.subscription.update({
        where: { id: existingSub.id },
        data: {
          pendingSubscriptionId: payload.appSubscription.id,
          pendingPlanKey: planKey,
          pendingPlanName: plan.name,
        },
      });
    } else {
      await db.subscription.create({
        data: {
          shop,
          status: "PENDING",
          pendingSubscriptionId: payload.appSubscription.id,
          pendingPlanKey: planKey,
          pendingPlanName: plan.name,
        },
      });
    }

    await db.filterTrack.update({
      where: { id: commandRow.id },
      data: {
        value: {
          ...commandValue,
          status: "PENDING_CONFIRMATION",
          confirmationUrl: payload.confirmationUrl || null,
          subscriptionId: payload.appSubscription?.id || null,
        },
      },
    });

    return {
      success: true,
      commandId,
      status: "PENDING_CONFIRMATION",
      confirmationUrl: payload.confirmationUrl || null,
    };
  },
  { connection, concurrency: 1 },
);

export default subscriptionBillingWorker;
