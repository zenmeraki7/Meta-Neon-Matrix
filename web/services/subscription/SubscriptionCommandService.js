import crypto from "crypto";
import { db } from "../../repositories/repositoryDb.js";
import { PLANS } from "../SubscriptionService/SubscriptionService.js";
import { addSubscriptionBillingJob } from "../../Jobs/Queues/subscriptionBillingJob.js";

const COMMAND_TYPE = "subscription_command";

function parseValue(value) {
  return value && typeof value === "object" ? value : {};
}

export class SubscriptionCommandService {
  async createSubscriptionCommand({ shop, command, idempotencyKey }) {
    if (!shop) throw new Error("SHOP_REQUIRED");
    const planKey = String(command?.planKey || "").trim();
    const returnUrl = command?.returnUrl || null;
    const plan = PLANS[planKey];
    if (!plan) throw new Error("INVALID_PLAN_SELECTED");

    const idemKey = String(idempotencyKey || "").trim();
    if (idemKey) {
      const existing = await db.filterTrack.findFirst({
        where: {
          shop,
          type: COMMAND_TYPE,
          field: planKey,
          searchKey: idemKey,
        },
      });
      if (existing) {
        const value = parseValue(existing.value);
        return {
          commandId: existing.id,
          status: String(value.status || "PENDING_CONFIRMATION"),
          confirmationUrl: value.confirmationUrl || null,
        };
      }
    }

    const commandId = crypto.randomUUID();
    await db.filterTrack.create({
      data: {
        id: commandId,
        shop,
        type: COMMAND_TYPE,
        field: planKey,
        searchKey: idemKey || null,
        value: {
          status: "PENDING_CONFIRMATION",
          planKey,
          returnUrl,
        },
      },
    });

    await addSubscriptionBillingJob({
      commandId,
      shop,
    });

    return {
      commandId,
      status: "PENDING_CONFIRMATION",
      confirmationUrl: null,
    };
  }
}

export default SubscriptionCommandService;

