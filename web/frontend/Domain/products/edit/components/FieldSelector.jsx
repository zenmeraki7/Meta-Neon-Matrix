import React, {
  memo,
  useCallback,
  useDeferredValue,
  useMemo,
  useState,
} from "react";
import { Autocomplete, Icon, Text, BlockStack, Box } from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";
import { useTranslation } from "react-i18next";
import {
  COMMON_EDIT_FIELD_VALUES,
  NORMALIZED_EDIT_FIELDS,
} from "../constants";

const FIELD_CATEGORIES = Object.freeze([
  {
    value: "product",
    titleKey: "products:productFields",
    defaultTitle: "Product fields",
  },
  {
    value: "variant",
    titleKey: "products:variantFields",
    defaultTitle: "Variant fields",
  },
  {
    value: "danger",
    titleKey: "products:dangerZone",
    defaultTitle: "Danger zone",
  },
]);

const MAX_OPTIONS_PER_CATEGORY = 15;
const MAX_TOTAL_OPTIONS = 40;
const AUTOCOMPLETE_OFF = "off";
const FIELD_HELPER_MIN_HEIGHT = "20px";
const STACK_GAP = "150";
const TEXT_PARAGRAPH = "p";
const BODY_SMALL = "bodySm";
const TONE_CRITICAL = "critical";
const TONE_SUBDUED = "subdued";

function safeString(value, fallback = "") {
  if (value === undefined || value === null) return fallback;

  const stringValue = String(value).trim();

  return stringValue || fallback;
}

function resolveSelectedFieldValue(selectedField) {
  if (typeof selectedField === "string") {
    return safeString(selectedField);
  }

  return safeString(selectedField?.value);
}

function normalizeForSearch(value) {
  return safeString(value)
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_./:-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  return normalizeForSearch(value).split(" ").filter(Boolean);
}

function buildSearchTokens(field) {
  return tokenize(
    [
      field.value,
      field.defaultLabel,
      field.category,
      field.translatedLabel,
      ...(field.searchTerms || []),
    ].join(" "),
  );
}

function matchesQuery(field, queryTokens) {
  if (queryTokens.length === 0) return true;

  return queryTokens.every((token) => {
    return (
      field.searchTokens.includes(token) ||
      field.searchableText.includes(token)
    );
  });
}

function toSelectedFieldPayload(field) {
  if (!field) return null;

  return {
    value: field.value,
    category: field.category,
    requiresConfirmation: field.requiresConfirmation === true,
    riskLevel: field.riskLevel,
    confirmationPhrase: field.confirmationPhrase,
  };
}

function FieldSelector({ selectedField, onFieldChange, disabled = false }) {
  const { t } = useTranslation(["products", "common"]);
  const [inputValue, setInputValue] = useState("");

  const deferredInputValue = useDeferredValue(inputValue);
  const selectedFieldValue = resolveSelectedFieldValue(selectedField);

  const translatedFields = useMemo(() => {
    return NORMALIZED_EDIT_FIELDS.map((field) => {
      const translatedLabel = t(field.labelKey, {
        defaultValue: field.defaultLabel,
      });

      const translatedField = {
        ...field,
        translatedLabel,
      };

      return {
        ...translatedField,
        searchTokens: buildSearchTokens(translatedField),
        searchableText: normalizeForSearch(
          [
            translatedField.value,
            translatedField.defaultLabel,
            translatedField.category,
            translatedField.translatedLabel,
            ...(translatedField.searchTerms || []),
          ].join(" "),
        ),
      };
    });
  }, [t]);

  const fieldByValue = useMemo(() => {
    return new Map(translatedFields.map((field) => [field.value, field]));
  }, [translatedFields]);

  const fieldsByCategory = useMemo(() => {
    const grouped = new Map();

    for (const field of translatedFields) {
      const current = grouped.get(field.category) || [];
      current.push(field);
      grouped.set(field.category, current);
    }

    return grouped;
  }, [translatedFields]);

  const selectedFieldDefinition = selectedFieldValue
    ? fieldByValue.get(selectedFieldValue) || null
    : null;

  const selected = useMemo(
    () => (selectedFieldDefinition ? [selectedFieldDefinition.value] : []),
    [selectedFieldDefinition]
  );

  const options = useMemo(() => {
    const queryTokens = tokenize(deferredInputValue);
    const commonFields = new Set(COMMON_EDIT_FIELD_VALUES);
    let totalOptions = 0;

    return FIELD_CATEGORIES.map((category) => {
      const fields = fieldsByCategory.get(category.value) || [];
      const categoryOptions = [];

      for (const field of fields) {
        if (totalOptions >= MAX_TOTAL_OPTIONS) break;

        if (queryTokens.length === 0 && !commonFields.has(field.value)) {
          continue;
        }

        if (!matchesQuery(field, queryTokens)) {
          continue;
        }

        categoryOptions.push({
          value: field.value,
          label: field.translatedLabel,
        });
        totalOptions += 1;

        if (categoryOptions.length >= MAX_OPTIONS_PER_CATEGORY) break;
      }

      if (categoryOptions.length === 0) {
        return null;
      }

      return {
        title: t(category.titleKey, {
          defaultValue: category.defaultTitle,
        }),
        options: categoryOptions,
      };
    }).filter(Boolean);
  }, [deferredInputValue, fieldsByCategory, t]);

  const handleInputChange = useCallback((value) => {
    setInputValue(value);
  }, []);

  const handleSelect = useCallback(
    (selectedValues) => {
      if (typeof onFieldChange !== "function") {
        return;
      }

      const nextValue = Array.isArray(selectedValues)
        ? safeString(selectedValues[0])
        : "";

      if (!nextValue) {
        onFieldChange(null);
        return;
      }

      onFieldChange(toSelectedFieldPayload(fieldByValue.get(nextValue)));
      setInputValue("");
    },
    [fieldByValue, onFieldChange]
  );

  const textField = useMemo(
    () => (
      <Autocomplete.TextField
        label={t("products:fieldToEdit", {
          defaultValue: "Field to edit",
        })}
        value={inputValue}
        onChange={handleInputChange}
        placeholder={t("products:selectFieldPlaceholder", {
          defaultValue: "Search fields",
        })}
        prefix={<Icon source={SearchIcon} />}
        autoComplete={AUTOCOMPLETE_OFF}
        disabled={disabled}
      />
    ),
    [disabled, handleInputChange, inputValue, t]
  );

  const isDisabled = disabled || NORMALIZED_EDIT_FIELDS.length === 0;

  return (
    <BlockStack gap={STACK_GAP}>
      <Autocomplete
        options={options}
        selected={selected}
        onSelect={handleSelect}
        textField={textField}
        disabled={isDisabled}
      />

      <Box minHeight={FIELD_HELPER_MIN_HEIGHT}>
        {selectedFieldDefinition ? (
          <Text
            as={TEXT_PARAGRAPH}
            variant={BODY_SMALL}
            tone={
              selectedFieldDefinition.requiresConfirmation
                ? TONE_CRITICAL
                : TONE_SUBDUED
            }
          >
            {selectedFieldDefinition.requiresConfirmation
              ? t("products:selectedDangerField", {
                  defaultValue:
                    "Selected field: {{field}}. This field may require extra confirmation.",
                  field: selectedFieldDefinition.translatedLabel,
                })
              : t("products:selectedField", {
                  defaultValue: "Selected field: {{field}}",
                  field: selectedFieldDefinition.translatedLabel,
                })}
          </Text>
        ) : null}
      </Box>
    </BlockStack>
  );
}

export default memo(FieldSelector);
