export const BILLING_PLANS = Object.freeze({
  basic: Object.freeze({
    slug: "basic",
    planKey: "BASIC_MONTHLY",
    name: "Basic",
    price: 25,
    trialDays: 0,
  }),
  advanced: Object.freeze({
    slug: "advanced",
    planKey: "ADVANCED_MONTHLY",
    name: "Advanced",
    price: 50,
    trialDays: 0,
  }),
  pro: Object.freeze({
    slug: "pro",
    planKey: "PRO_MONTHLY",
    aliases: Object.freeze(["PROFESSIONAL_MONTHLY"]),
    name: "Pro",
    price: 110,
    trialDays: 0,
  }),
});

const BILLING_PLAN_ALIASES = Object.freeze({
  BASIC_MONTHLY: "basic",
  "BASIC MONTHLY": "basic",
  ADVANCED_MONTHLY: "advanced",
  "ADVANCED MONTHLY": "advanced",
  PROFESSIONAL: "pro",
  "PROFESSIONAL MONTHLY": "pro",
  PROFESSIONAL_MONTHLY: "pro",
  "PRO MONTHLY": "pro",
  PRO_MONTHLY: "pro",
});

export function resolveBillingPlan(value) {
  const raw = String(value || "").trim();
  const normalized = raw.toLowerCase();
  const alias = BILLING_PLAN_ALIASES[raw.toUpperCase()] || normalized;
  return BILLING_PLANS[alias] || null;
}

export function getBillingPlanSlugs() {
  return Object.keys(BILLING_PLANS);
}
