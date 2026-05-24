import { planMutationExecution } from "./planner/mutationPlanner.js";

export function getPlanMaxBulkEditTargets(subscription = {}) {
  const planKey = String(subscription?.planKey || "FREE").toUpperCase();

  const enterpriseMax = Number.parseInt(
    process.env.ENTERPRISE_MAX_BULK_EDIT_TARGETS || "250000",
    10,
  );

  if (planKey === "PRO_MONTHLY") return 100000;

  if (planKey === "ADVANCED_MONTHLY" || planKey === "BASIC_MONTHLY") {
    return 10000;
  }

  if (planKey.includes("ENTERPRISE")) {
    return Number.isFinite(enterpriseMax) ? enterpriseMax : 250000;
  }

  return 1000;
}

export function buildExecutionPlanForEdit({
  operationKey = null,
  operationId = null,
  shop = null,
  planType = "BULK_EDIT",
  rules = [],
  targetGranularity = "PRODUCT",
  targetCount = 0,
  shopPlanLimits = {},
} = {}) {
  const fieldsBeingEdited = Array.isArray(rules)
    ? rules.map((rule) => rule?.field).filter(Boolean)
    : [];

  return planMutationExecution({
    operationKey,
    operationId,
    shop,
    planType,
    mutationIntent: {
      mutationType: "PRODUCT_SET",
      fieldsBeingEdited,
    },
    targetGranularity,
    targetCount,
    fieldsBeingEdited,
    shopPlanLimits,
  });
}
