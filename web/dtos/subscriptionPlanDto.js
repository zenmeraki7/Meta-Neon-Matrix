function safePlan(plan = {}, currentPlanKey = "FREE") {
  const key = String(plan?.key || "").trim() || "FREE";
  const features = Array.isArray(plan?.features)
    ? plan.features.map((feature) => String(feature || "").trim()).filter(Boolean)
    : [];

  return {
    key,
    name: String(plan?.name || "").trim() || key,
    description: String(plan?.description || "").trim(),
    price: plan?.price ?? null,
    compareAtPrice: plan?.compareAtPrice ?? null,
    interval: plan?.interval ?? null,
    features,
    buttonText: String(plan?.buttonText || "").trim() || "Select plan",
    buttonVariant: String(plan?.buttonVariant || "").trim() || "secondary",
    isFree: plan?.isFree === true,
    popular: plan?.popular === true,
    isCurrent: key === currentPlanKey,
    highlight: String(plan?.highlight || "").trim(),
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

