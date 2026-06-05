import { FIELD_CONFIGS } from "../../helpers/productBulkOperationHelpers/constants.js";
import { getUpdatedProducts } from "../../helpers/productBulkOperationHelpers/productUpdateHandler.js";
import { TARGET_GRANULARITIES } from "../targeting/constants.js";

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

const FIELD_ALIASES = Object.freeze({
  compare_at_price: "compareAtPrice",
  compareatprice: "compareAtPrice",
  product_type: "productType",
  producttype: "productType",
  option1values: "option1Values",
  option_1_values: "option1Values",
  option2values: "option2Values",
  option_2_values: "option2Values",
  option3values: "option3Values",
  option_3_values: "option3Values",
  option1name: "option1Name",
  option_1_name: "option1Name",
  option2name: "option2Name",
  option_2_name: "option2Name",
  option3name: "option3Name",
  option_3_name: "option3Name",
});

const CANONICAL_FIELD_BY_LOWERCASE = Object.freeze(
  Object.keys(FIELD_CONFIGS || {}).reduce((acc, fieldName) => {
    acc[String(fieldName).toLowerCase()] = fieldName;
    return acc;
  }, {}),
);

export function normalizeField(field) {
  if (field === null || field === undefined) {
    throw new Error("BULK_EDIT_RULE_FIELD_REQUIRED");
  }

  const trimmed = field.toString().trim();
  if (!trimmed) {
    throw new Error("BULK_EDIT_RULE_FIELD_REQUIRED");
  }
  const key = trimmed.toLowerCase();
  return FIELD_ALIASES[key] || CANONICAL_FIELD_BY_LOWERCASE[key] || trimmed;
}

export function isVariantLevelField(field) {
  const normalizedField = normalizeField(field);
  const config = FIELD_CONFIGS?.[normalizedField];
  if (config && Object.prototype.hasOwnProperty.call(config, "isVariantLevel")) {
    return config.isVariantLevel === true;
  }
  return VARIANT_LEVEL_FIELDS.has(normalizedField);
}

export function resolveTargetGranularityFromRules(rules = []) {
  const fields = Array.isArray(rules)
    ? rules.map((rule) => normalizeField(rule?.field))
    : [];

  const hasVariantField = fields.some((field) => isVariantLevelField(field));
  const hasProductField = fields.some(
    (field) =>
      !isVariantLevelField(field)
      && !OPTION_NAME_FIELDS.has(field)
      && field !== "deleteProducts",
  );
  if (hasVariantField && hasProductField) {
    return TARGET_GRANULARITIES.PRODUCT_WITH_MATCHING_VARIANTS;
  }
  return hasVariantField ? TARGET_GRANULARITIES.VARIANT : TARGET_GRANULARITIES.PRODUCT;
}

function hasSingleRuleFields(body = {}) {
  return [
    body.editedField,
    body.field,
    body.editedType,
    body.editType,
    body.value,
    body.editValue,
  ].some((value) => value !== undefined && value !== null);
}

function normalizeRuleShape(rule = {}) {
  const editOption = rule.editOption ?? rule.operator ?? rule.editedType ?? rule.editType ?? null;
  return {
    ...rule,
    field: normalizeField(rule.field ?? rule.editedField),
    value: rule.value ?? rule.editValue ?? null,
    editOption,
    operator: editOption,
    searchKey: rule.searchKey ?? null,
    replaceText: rule.replaceText ?? null,
    supportValue: rule.supportValue ?? null,
    locationId: rule.locationId ?? null,
  };
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
    if (hasSingleRuleFields(body)) {
      throw new Error("BULK_EDIT_RULE_INPUT_SHAPE_AMBIGUOUS");
    }
    return explicitRules.map((rule) => normalizeRuleShape(rule));
  }

  if (Array.isArray(explicitRules) && explicitRules.length === 0) {
    throw new Error("BULK_EDIT_RULES_REQUIRED");
  }

  const resolvedField = editedField ?? body.field;
  const resolvedValue = value ?? body.editValue;
  const resolvedEditOption = editedType ?? body.editType;
  if (resolvedField === undefined || resolvedField === null) {
    throw new Error("BULK_EDIT_RULE_FIELD_REQUIRED");
  }

  return [
    normalizeRuleShape({
      field: resolvedField,
      value: resolvedValue,
      editOption: resolvedEditOption,
      searchKey,
      replaceText,
      supportValue,
      locationId: locationId ?? null,
    }),
  ];
}

export function buildEditIntentFromRules(rules = []) {
  return Array.isArray(rules)
    ? rules.filter(Boolean).map((rule) => {
      const normalized = normalizeRuleShape(rule);
      return {
        field: normalized.field,
        editOption: normalized.editOption,
        operator: normalized.operator,
        value: normalized.value,
        supportValue: normalized.supportValue,
        searchKey: normalized.searchKey,
        replaceText: normalized.replaceText,
        locationId: normalized.locationId,
      };
    })
    : [];
}

export function buildHistoryTitle(rules = []) {
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

  return updatedTitle || "Bulk edit";
}
