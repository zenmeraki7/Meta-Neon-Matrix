import crypto from "crypto";
import { db } from "../../repositories/repositoryDb.js";
import { PLANS } from "../SubscriptionService/SubscriptionService.js";
import { addSubscriptionBillingJob } from "../../Jobs/Queues/subscriptionBillingJob.js";

export class SubscriptionCommandService {
  async createSubscriptionCommand({ shop, command, idempotencyKey }) {
    if (!shop) throw new Error("SHOP_REQUIRED");
    const planKey = String(command?.planKey || "").trim();
    const returnUrl = command?.returnUrl || null;
    const plan = PLANS[planKey];
    if (!plan) throw new Error("INVALID_PLAN_SELECTED");

    const idemKey = String(idempotencyKey || "").trim();
    const idempotencyKeyHash = idemKey
      ? crypto.createHash("sha256").update(idemKey, "utf8").digest("hex")
      : null;
    if (idemKey) {
      const existing = await db.subscriptionCommand.findFirst({
        where: { shop, idempotencyKeyHash },
      });
      if (existing) {
        return {
          commandId: existing.id,
          status: existing.status,
          confirmationUrl: existing.confirmationUrl,
        };
      }
    }

    const commandId = crypto.randomUUID();
    await db.subscriptionCommand.createMany({
      data: [{
        id: commandId,
        shop,
        planKey,
        returnUrl,
        status: "PENDING_CONFIRMATION",
        idempotencyKeyHash,
      }],
      skipDuplicates: true,
    });

    const persisted = idempotencyKeyHash
      ? await db.subscriptionCommand.findFirst({ where: { shop, idempotencyKeyHash } })
      : await db.subscriptionCommand.findFirst({ where: { shop, id: commandId } });
    if (!persisted) throw new Error("SUBSCRIPTION_COMMAND_PERSIST_FAILED");

    await addSubscriptionBillingJob({
      commandId: persisted.id,
      shop,
    });

    return {
      commandId: persisted.id,
      status: persisted.status,
      confirmationUrl: persisted.confirmationUrl,
    };
  }
}

export default SubscriptionCommandService;
