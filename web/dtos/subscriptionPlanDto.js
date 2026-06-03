function safePlan(plan = {}, currentPlanKey = "FREE") {
  const key = String(plan?.key || "").trim() || "FREE";
  const features = Array.isArray(plan?.features)
    ? plan.features.map((feature) => String(feature || "").trim()).filter(Boolean)
    : [];

  return {
    key,
    name: String(plan?.name || "").trim() || key,
    price: plan?.price ?? null,
    compareAtPrice: plan?.compareAtPrice ?? null,
    trialDays: Number.isFinite(Number(plan?.trialDays)) ? Number(plan.trialDays) : 0,
    interval: plan?.interval ?? null,
    isCurrent: key === currentPlanKey,
    isFree: Boolean(plan?.isFree),
    description: String(plan?.description || "").trim(),
    highlight: String(plan?.highlight || "").trim(),
    popular: Boolean(plan?.popular),
    features,
    buttonText: String(plan?.buttonText || "").trim(),
    buttonVariant: String(plan?.buttonVariant || "primary").trim(),
  };
}

export function toSubscriptionPlanSnapshotDto(snapshot = {}) {
  const currentPlanKey = String(snapshot?.currentPlanKey || "FREE").trim() || "FREE";
  const plans = Array.isArray(snapshot?.plans)
    ? snapshot.plans.map((plan) => safePlan(plan, currentPlanKey))
    : [];

  return {
    success: true,
    currentPlanKey,
    plans,
  };
}

