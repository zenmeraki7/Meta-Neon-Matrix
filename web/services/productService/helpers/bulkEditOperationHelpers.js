import { FIELD_CONFIGS } from "../../../helpers/productBulkOperationHelpers/constants.js";
import { getUpdatedProducts } from "../../../helpers/productBulkOperationHelpers/productUpdateHandler.js";
import { createMultiLanguage } from "../../../utils/googleTranslator.js";
import { planMutationExecution } from "../../bulkEdit/planner/mutationPlanner.js";

const VARIANT_LEVEL_FIELDS = new Set([
  "price",
  "barcode",
  "sku",
  "inventory",
  "taxable",
  "compareAtPrice",
  "option1Values",
  "option2Values",
  "option3Values",
  "inventoryPolicy",
  "cost",
  "requiresShipping",
  "weight",
  "weightUnit",
]);

export function isVariantLevelField(field) {
  if (FIELD_CONFIGS?.[field]?.isVariantLevel) return true;
  return VARIANT_LEVEL_FIELDS.has(field);
}

export function normalizeRules(body) {
  const {
    editedType,
    editedField,
    value,
    searchKey,
    replaceText,
    supportValue,
    rules: explicitRules,
    locationId,
  } = body;

  if (Array.isArray(explicitRules) && explicitRules.length > 0) {
    return explicitRules;
  }

  return [{
    field: editedField,
    value,
    editOption: editedType,
    searchKey,
    replaceText,
    supportValue,
    locationId: locationId ?? null,
  }];
}

export async function buildHistoryTitle(rules) {
  const updatedTitle = rules
    .map((rule) =>
      getUpdatedProducts({
        field: rule.field,
        editType: rule.editOption,
        value: rule.value,
        supportValue: rule.supportValue,
        searchKey: rule.searchKey,
        replaceText: rule.replaceText,
        returnTitleOnly: true,
      }))
    .filter(Boolean)
    .join(" + ");

  return createMultiLanguage(updatedTitle || "Bulk edit");
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

export function deriveTargetGranularityFromRules(rules = []) {
  const normalizedRules = Array.isArray(rules) ? rules.filter(Boolean) : [];
  return normalizedRules.some((rule) => isVariantLevelField(rule?.field)) ? "VARIANT" : "PRODUCT";
}

export function buildEditIntentFromRules(rules = []) {
  const normalizedRules = Array.isArray(rules) ? rules.filter(Boolean) : [];
  return normalizedRules.map((rule) => ({
    field: rule.field ?? null,
    operator: rule.editOption ?? null,
    value: rule.value ?? null,
    supportValue: rule.supportValue ?? null,
    searchKey: rule.searchKey ?? null,
    replaceText: rule.replaceText ?? null,
    locationId: rule.locationId ?? null,
  }));
}

export function getPlanMaxBulkEditTargets(subscription = {}) {
  const planKey = String(subscription?.planKey || "FREE").toUpperCase();
  const enterpriseMax = Number.parseInt(process.env.ENTERPRISE_MAX_BULK_EDIT_TARGETS || "250000", 10);
  if (planKey === "PRO_MONTHLY") return 100000;
  if (planKey === "ADVANCED_MONTHLY" || planKey === "BASIC_MONTHLY") return 10000;
  if (planKey.includes("ENTERPRISE")) return Number.isFinite(enterpriseMax) ? enterpriseMax : 250000;
  return 1000;
}

