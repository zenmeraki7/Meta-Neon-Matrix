import { recurringEditRepository } from "../repositories/recurringEditRepository.js";
import { resolveBillingPlan } from "./billingPlanRegistry.js";

const RECURRING_EDIT_PLAN_KEYS = new Set([
  "BASIC_MONTHLY",
  "ADVANCED_MONTHLY",
  "PRO_MONTHLY",
  "PROFESSIONAL_MONTHLY",
]);
const MAX_ACTIVE_RECURRING_EDITS = 10;
export const RECURRING_EDIT_PAID_PLAN_REQUIRED_MESSAGE =
  "Recurring edits are available on paid plans. Please upgrade to continue.";

export class RecurringEditPlanError extends Error {
  constructor(message = RECURRING_EDIT_PAID_PLAN_REQUIRED_MESSAGE) {
    super(message);
    this.name = "RecurringEditPlanError";
    this.code = "RECURRING_EDIT_PRO_PLAN_REQUIRED";
    this.statusCode = 403;
    this.expose = true;
    this.details = {
      upgradeRequired: true,
      requiredPlan: "paid",
      feature: "recurring_edits",
      billingUrl: "/pricing",
    };
  }
}

export function isRecurringEditPlanError(error) {
  return (
    error instanceof RecurringEditPlanError ||
    error?.code === "RECURRING_EDIT_PRO_PLAN_REQUIRED"
  );
}

export function hasRecurringEditAccess(subscription = {}) {
  const planKey = String(subscription?.planKey || "FREE").toUpperCase();
  const billingPlan = resolveBillingPlan(planKey);

  return (
    subscription?.isCreditUser === true ||
    (subscription?.status === "ACTIVE" &&
      (RECURRING_EDIT_PLAN_KEYS.has(planKey) || Boolean(billingPlan?.planKey)))
  );
}

export async function assertPaidRecurringEditAccess(subscription = {}) {
  if (!hasRecurringEditAccess(subscription)) {
    throw new RecurringEditPlanError();
  }
}

export const assertProRecurringEditAccess = assertPaidRecurringEditAccess;

export async function assertRecurringEditActiveLimit({
  shop,
  excludeRecurringEditId = null,
}) {
  const activeCount = await recurringEditRepository.countActiveByShop(
    shop,
    excludeRecurringEditId,
  );

  if (activeCount >= MAX_ACTIVE_RECURRING_EDITS) {
    throw new Error(
      `Your store already has ${MAX_ACTIVE_RECURRING_EDITS} active recurring edits. Pause or cancel one before activating another.`,
    );
  }
}

export { MAX_ACTIVE_RECURRING_EDITS };
