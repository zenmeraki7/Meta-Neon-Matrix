import { ValidationRule } from "../Domain/products/edit/hooks/useFiledValidation";

type NumericKind = "money" | "inventory" | "percentage" | "number";

interface ValueValidationOptions {
  numericKind?: NumericKind;
  maxPercentage?: number;
}

export const getValueValidationRules = (
  isPercentage: boolean,
  isFixedValue: boolean,
  options: ValueValidationOptions = {},
): ValidationRule => {
  const numericKind = options.numericKind || "number";
  const maxPercentage = options.maxPercentage ?? 100;

  if (isPercentage) {
    return {
      required: true,
      isNumber: true,
      min: 0,
      max: maxPercentage,
      pattern: /^\d{1,3}(\.\d{0,2})?$/,
    };
  }

  if (isFixedValue) {
    if (numericKind === "money") {
      return {
        required: true,
        isNumber: true,
        min: 0,
        max: 999999999.99,
        pattern: /^\d{1,9}(\.\d{0,2})?$/,
      };
    }

    if (numericKind === "inventory") {
      return {
        required: true,
        isNumber: true,
        integer: true,
        min: 0,
        max: 9999999,
        pattern: /^\d{1,7}$/,
      };
    }

    return {
      required: true,
      isNumber: true,
      min: 0,
    };
  }

  return {};
};
