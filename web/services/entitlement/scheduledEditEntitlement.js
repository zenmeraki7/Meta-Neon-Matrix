const ACTIVE_STATUSES = new Set(["ACTIVE"]);
const PAID_PLAN_KEYS = new Set(["ADVANCED_MONTHLY", "PRO_MONTHLY"]);
const DEFAULT_BILLING_URL = "/pricing";

export const SCHEDULED_EDITS_FEATURE = "scheduled_edits";
export const SCHEDULED_EDITS_UPGRADE_MESSAGE =
  "Scheduled edits require an active paid plan.";

export function canUseScheduledEdits(subscription = {}) {
  if (subscription?.isCreditUser === true) {
    return true;
  }

  const planKey = String(subscription?.planKey || "FREE").toUpperCase();
  const status = String(subscription?.status || "FREE").toUpperCase();

  return PAID_PLAN_KEYS.has(planKey) && ACTIVE_STATUSES.has(status);
}

export function getScheduleEditBillingUrl() {
  return DEFAULT_BILLING_URL;
}

export function buildScheduleEditCapability(subscription = {}) {
  const planKey = String(subscription?.planKey || "FREE").toUpperCase();
  const planName = String(subscription?.planName || "").trim() || "Free Plan";

  return {
    canScheduleEdits: canUseScheduledEdits(subscription),
    planKey,
    planName,
    upgradeUrl: DEFAULT_BILLING_URL,
    billingUrl: DEFAULT_BILLING_URL,
  };
}
