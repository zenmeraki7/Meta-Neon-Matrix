import { resolveBillingPlan } from "../billingPlanRegistry.js";

const ACTIVE_STATUSES = new Set(["ACTIVE"]);
const SCHEDULED_EDIT_PLAN_KEYS = new Set([
  "BASIC_MONTHLY",
  "ADVANCED_MONTHLY",
  "PRO_MONTHLY",
  "DEV_TEST",
]);
const SCHEDULED_EXPORT_PLAN_KEYS = new Set([
  "ADVANCED_MONTHLY",
  "PRO_MONTHLY",
  "DEV_TEST",
]);

export const DEFAULT_BILLING_URL = "/pricing";
export const SCHEDULED_EDITS_FEATURE = "scheduled_edits";
export const SCHEDULED_EXPORTS_FEATURE = "scheduled_exports";
export const SCHEDULED_EDITS_UPGRADE_MESSAGE =
  "Scheduled edits require an active paid plan.";
export const SCHEDULED_EXPORTS_UPGRADE_MESSAGE =
  "Scheduled exports are not available on your current plan.";

export function normalizePlanKey(planKey) {
  const raw = String(planKey || "FREE").trim().toUpperCase();
  if (raw === "FREE" || raw === "DEV_TEST") return raw;

  return resolveBillingPlan(raw)?.planKey || raw;
}

export function isKnownPlanKey(planKey) {
  return ["FREE", "BASIC_MONTHLY", "ADVANCED_MONTHLY", "PRO_MONTHLY", "DEV_TEST"]
    .includes(normalizePlanKey(planKey));
}

function isActive(subscription = {}) {
  if (subscription?.isCreditUser === true) return true;

  const status = String(subscription?.status || "FREE").toUpperCase();
  return ACTIVE_STATUSES.has(status);
}

export function buildPlanCapabilities(subscription = {}) {
  const planKey = subscription?.isCreditUser === true
    ? "PRO_MONTHLY"
    : normalizePlanKey(subscription?.planKey);
  const planName = String(subscription?.planName || "").trim() || "Free Plan";
  const active = isActive(subscription);

  return {
    canScheduleEdits: active && SCHEDULED_EDIT_PLAN_KEYS.has(planKey),
    canScheduleExports: active && SCHEDULED_EXPORT_PLAN_KEYS.has(planKey),
    planKey,
    planName,
    isDevelopmentPlan: planKey === "DEV_TEST",
    upgradeUrl: DEFAULT_BILLING_URL,
    billingUrl: DEFAULT_BILLING_URL,
  };
}
