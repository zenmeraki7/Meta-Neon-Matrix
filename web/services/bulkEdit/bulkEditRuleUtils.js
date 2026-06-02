import { FIELD_CONFIGS } from "../../helpers/productBulkOperationHelpers/constants.js";
import { getUpdatedProducts } from "../../helpers/productBulkOperationHelpers/productUpdateHandler.js";
import { createMultiLanguage } from "../../utils/googleTranslator.js";
import {
  buildExecutionPlanForEdit,
  getPlanMaxBulkEditTargets,
} from "../productService/helpers/bulkEditOperationHelpers.js";

export const OPTION_NAME_FIELDS = new Set([
  "option1Name",
  "option2Name",
  "option3Name",
  "mixed",
]);

export const VARIANT_LEVEL_FIELDS = new Set([
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

export function normalizeField(field) {
  if (!field) return field;

  const map = {
    compare_at_price: "compareAtPrice",
    compareatprice: "compareAtPrice",
    option1values: "option1Values",
    option2values: "option2Values",
    option3values: "option3Values",
  };

  const key = field.toString().trim();
  return map[key] || key;
}

export function isVariantLevelField(field) {
  if (FIELD_CONFIGS?.[field]?.isVariantLevel) return true;
  return VARIANT_LEVEL_FIELDS.has(field);
}

export function resolveTargetGranularityFromRules(rules = []) {
  const fields = Array.isArray(rules)
    ? rules.map((rule) => rule?.field).filter(Boolean)
    : [];

  const hasVariantField = fields.some((field) => isVariantLevelField(field));
  return hasVariantField ? "VARIANT" : "PRODUCT";
}

export function normalizeRules(body = {}) {
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
    return explicitRules.map((rule) => ({
      ...rule,
      field: normalizeField(rule.field),
    }));
  }

  return [
    {
      field: normalizeField(editedField),
      value,
      editOption: editedType,
      searchKey,
      replaceText,
      supportValue,
      locationId: locationId ?? null,
    },
  ];
}

export function buildEditIntentFromRules(rules = []) {
  return Array.isArray(rules)
    ? rules.filter(Boolean).map((rule) => ({
      field: rule.field ?? null,
      operator: rule.editOption ?? null,
      value: rule.value ?? null,
      supportValue: rule.supportValue ?? null,
      searchKey: rule.searchKey ?? null,
      replaceText: rule.replaceText ?? null,
      locationId: rule.locationId ?? null,
    }))
    : [];
}

export async function buildHistoryTitle(rules = []) {
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

// Backward-compatible alias for ongoing migration.
export function deriveTargetGranularityFromRules(rules = []) {
  return resolveTargetGranularityFromRules(rules);
}

export { buildExecutionPlanForEdit, getPlanMaxBulkEditTargets };
