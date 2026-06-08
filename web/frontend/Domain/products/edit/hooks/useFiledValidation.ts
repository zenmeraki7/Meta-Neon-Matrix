// hooks/useFieldValidation.ts
import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';


export interface ValidationRule {
  required?: boolean;
  min?: number;
  max?: number;
  isNumber?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  custom?: (value: string, t: TFunction) => string | undefined;
  // Enterprise additions
  email?: boolean;
  url?: boolean;
  integer?: boolean;
  positive?: boolean;
  alphanumeric?: boolean;
  noWhitespace?: boolean;
}

// Pre-compiled regex patterns for performance
const VALIDATION_PATTERNS = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  alphanumeric: /^[a-zA-Z0-9]+$/,
  noWhitespace: /^\S+$/,
} as const;

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeRuleForSignature(value: unknown): unknown {
  if (value instanceof RegExp) {
    return value.toString();
  }

  if (typeof value === 'function') {
    return `[function:${value.name || 'anonymous'}]`;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeRuleForSignature);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = normalizeRuleForSignature(
          (value as Record<string, unknown>)[key],
        );
        return acc;
      }, {});
  }

  return value;
}

function createValidationFieldsSignature(
  fields: Record<
    string,
    { value: string | number | null | undefined; rules: ValidationRule }
  >,
): string {
  return JSON.stringify(
    Object.keys(fields)
      .sort()
      .map((fieldName) => ({
        fieldName,
        value: fields[fieldName]?.value ?? null,
        rules: normalizeRuleForSignature(fields[fieldName]?.rules || {}),
      })),
  );
}

export function validateFieldValue(
  value: string | number | null | undefined,
  rules: ValidationRule = {},
  t: TFunction,
): string | undefined {
  const stringValue = String(value ?? '');
  const trimmedValue = stringValue.trim();

  if (rules.required && !trimmedValue) {
    return t('validation_new.required', {
      defaultValue: 'This field is required.',
    });
  }

  if (!trimmedValue && !rules.required) {
    return undefined;
  }

  const shouldValidateNumber =
    rules.isNumber ||
    rules.min != null ||
    rules.max != null ||
    rules.integer ||
    rules.positive;

  if (shouldValidateNumber) {
    const number = Number(trimmedValue);

    if (!Number.isFinite(number)) {
      return t('validation_new.invalidNumber', {
        defaultValue: 'Enter a valid number.',
      });
    }

    if (rules.integer && !Number.isInteger(number)) {
      return t('validation_new.integer', {
        defaultValue: 'Enter a whole number.',
      });
    }

    if (rules.positive && number <= 0) {
      return t('validation_new.positive', {
        defaultValue: 'Enter a positive number.',
      });
    }

    if (rules.min != null && number < rules.min) {
      return t('validation_new.minValue', {
        defaultValue: 'Value must be at least {{min}}.',
        min: rules.min,
      });
    }

    if (rules.max != null && number > rules.max) {
      return t('validation_new.maxValue', {
        defaultValue: 'Value must be at most {{max}}.',
        max: rules.max,
      });
    }
  }

  if (rules.minLength != null && stringValue.length < rules.minLength) {
    return t('validation_new.minLength', {
      defaultValue: 'Must be at least {{min}} characters.',
      min: rules.minLength,
    });
  }

  if (rules.maxLength != null && stringValue.length > rules.maxLength) {
    return t('validation_new.maxLength', {
      defaultValue: 'Must be at most {{max}} characters.',
      max: rules.maxLength,
    });
  }

  if (rules.email && !VALIDATION_PATTERNS.email.test(trimmedValue)) {
    return t('validation_new.email', {
      defaultValue: 'Enter a valid email address.',
    });
  }

  if (rules.url && !isValidHttpUrl(trimmedValue)) {
    return t('validation_new.url', {
      defaultValue: 'Enter a valid URL.',
    });
  }

  if (rules.alphanumeric && !VALIDATION_PATTERNS.alphanumeric.test(stringValue)) {
    return t('validation_new.alphanumeric', {
      defaultValue: 'Use only letters and numbers.',
    });
  }

  if (rules.noWhitespace && !VALIDATION_PATTERNS.noWhitespace.test(stringValue)) {
    return t('validation_new.noWhitespace', {
      defaultValue: 'Whitespace is not allowed.',
    });
  }

  if (rules.pattern && !rules.pattern.test(stringValue)) {
    return t('validation_new.invalidFormat', {
      defaultValue: 'Invalid format.',
    });
  }

  if (rules.custom) {
    return rules.custom(stringValue, t);
  }

  return undefined;
}

export const useFieldValidation = (
  value: string | number | null | undefined,
  rules: ValidationRule = {}
): string | undefined => {
  const { t } = useTranslation();

  return useMemo(
    () => validateFieldValue(value, rules, t),
    [value, rules, t],
  );
};

// Enhanced validation hook with multiple fields support for forms
export interface FormValidationState {
  isValid: boolean;
  errors: Record<string, string | undefined>;
  hasErrors: boolean;
  touchedFields: Set<string>;
  touchedFieldsByName: Record<string, boolean>;
}

export const useFormValidation = (
  fields: Record<string, { value: string | number | null | undefined; rules: ValidationRule }>,
  touched: Record<string, boolean> = {}
): FormValidationState => {
  const { t } = useTranslation();
  const previousFieldsRef = useRef<{
    fields: typeof fields;
    signature: string;
  } | null>(null);
  const fieldsSignature = useMemo(
    () => createValidationFieldsSignature(fields),
    [fields],
  );

  useEffect(() => {
    const previous = previousFieldsRef.current;

    if (
      previous &&
      previous.fields !== fields &&
      previous.signature === fieldsSignature &&
      import.meta.env.DEV
    ) {
      console.warn(
        'useFormValidation received a new fields object with unchanged validation content. Memoize the fields config in the parent.',
      );
    }

    previousFieldsRef.current = {
      fields,
      signature: fieldsSignature,
    };
  }, [fields, fieldsSignature]);

  return useMemo(() => {
    const errors: Record<string, string | undefined> = {};
    const touchedFieldsByName = Object.keys(touched).reduce<Record<string, boolean>>(
      (acc, key) => {
        if (touched[key]) {
          acc[key] = true;
        }
        return acc;
      },
      {},
    );
    const touchedFields = new Set(Object.keys(touchedFieldsByName));
    
    Object.entries(fields).forEach(([fieldName, { value, rules }]) => {
      const error = validateFieldValue(value, rules, t);
      if (error) {
        errors[fieldName] = error;
      }
    });
    
    const hasErrors = Object.values(errors).some(error => error !== undefined);
    const isValid = !hasErrors;
    
    return {
      isValid,
      errors,
      hasErrors,
      touchedFields,
      touchedFieldsByName,
    };
  }, [fields, touched, t]);
};

// Utility function for common validation rule sets
export const getCommonValidationRules = (type: 'email' | 'url' | 'phone' | 'shopifyHandle' | 'price' | 'sku'): ValidationRule => {
  const rules: Record<string, ValidationRule> = {
    email: {
      required: true,
      email: true,
      maxLength: 254, // RFC 5321 limit
    },
    url: {
      url: true,
      maxLength: 2048, // Common browser limit
    },
    phone: {
      pattern: /^\+?[\d\s\-\(\)]+$/,
      custom: (value: string, t: TFunction) => {
        const digits = value.replace(/\D/g, '');
        if (digits.length < 10) {
          return t('validation_new.phoneMinDigits', {
            defaultValue: 'Phone number must have at least 10 digits.',
          });
        }
        return undefined;
      }
    },
    shopifyHandle: {
      required: true,
      pattern: /^[a-z0-9\-]+$/,
      minLength: 1,
      maxLength: 255,
      custom: (value: string, t: TFunction) => {
        const normalizedValue = value.trim().toLowerCase();

        if (value !== normalizedValue) {
          return t('validation_new.handleLowercaseTrimmed', {
            defaultValue: 'Use a lowercase handle without leading or trailing spaces.',
          });
        }
        if (value.startsWith('-') || value.endsWith('-')) {
          return t('validation_new.handleHyphenBoundary', {
            defaultValue: 'Handle cannot start or end with a hyphen.',
          });
        }
        if (value.includes('--')) {
          return t('validation_new.handleConsecutiveHyphens', {
            defaultValue: 'Handle cannot contain consecutive hyphens.',
          });
        }
        return undefined;
      }
    },
    price: {
      required: true,
      isNumber: true,
      min: 0,
      max: 999999.99,
    },
    sku: {
      pattern: /^[a-zA-Z0-9\-_]+$/,
      minLength: 1,
      maxLength: 255,
      noWhitespace: true,
    }
  };
  
  return rules[type] || {};
};
