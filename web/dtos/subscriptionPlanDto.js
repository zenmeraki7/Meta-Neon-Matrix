function safePlan(plan = {}, currentPlanKey = "FREE") {
  const key = String(plan?.key || "").trim() || "FREE";
  return {
    key,
    name: String(plan?.name || "").trim() || key,
    price: plan?.price ?? null,
    interval: plan?.interval ?? null,
    isCurrent: key === currentPlanKey,
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

