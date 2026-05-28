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
import { getAllFields } from "../constants";

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

const MAX_OPTIONS_PER_CATEGORY = 50;

function safeString(value, fallback = "") {
  if (value === undefined || value === null) return fallback;

  const stringValue = String(value).trim();

  return stringValue || fallback;
}

function normalizeSearchTerms(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => safeString(item).toLowerCase())
    .filter(Boolean);
}

function normalizeFieldDefinitions(rawFields) {
  if (!Array.isArray(rawFields)) return [];

  const seenValues = new Set();
  const normalized = [];

  for (const field of rawFields) {
    const value = safeString(field?.value);
    const label = safeString(field?.label);
    const category = safeString(field?.category);

    if (!value || !label || !category || seenValues.has(value)) {
      continue;
    }

    seenValues.add(value);

    normalized.push({
      ...field,
      value,
      label,
      category,
      searchTerms: normalizeSearchTerms(field?.searchTerms || field?.aliases),
      requiresConfirmation:
        Boolean(field?.requiresConfirmation) || category === "danger",
    });
  }

  return normalized;
}

function resolveSelectedFieldValue(selectedField) {
  if (typeof selectedField === "string") {
    return safeString(selectedField);
  }

  return safeString(selectedField?.value);
}

function buildSearchableText(field) {
  return [
    field.value,
    field.label,
    field.category,
    field.translatedLabel,
    ...(field.searchTerms || []),
  ]
    .map((part) => safeString(part).toLowerCase())
    .filter(Boolean)
    .join(" ");
}

function FieldSelector({ selectedField, onFieldChange, disabled = false }) {
  const { t } = useTranslation(["products", "common"]);
  const [inputValue, setInputValue] = useState("");

  const deferredInputValue = useDeferredValue(inputValue);
  const selectedFieldValue = resolveSelectedFieldValue(selectedField);

  const allFields = useMemo(() => {
    return normalizeFieldDefinitions(getAllFields());
  }, []);

  const translatedFields = useMemo(() => {
    return allFields.map((field) => {
      const translatedLabel = t(field.label, {
        defaultValue: field.label,
      });

      const translatedField = {
        ...field,
        translatedLabel,
      };

      return {
        ...translatedField,
        searchableText: buildSearchableText(translatedField),
      };
    });
  }, [allFields, t]);

  const fieldByValue = useMemo(() => {
    return new Map(translatedFields.map((field) => [field.value, field]));
  }, [translatedFields]);

  const selectedFieldDefinition = selectedFieldValue
    ? fieldByValue.get(selectedFieldValue) || null
    : null;

  const selected = useMemo(
    () => (selectedFieldDefinition ? [selectedFieldDefinition.value] : []),
    [selectedFieldDefinition]
  );

  const options = useMemo(() => {
    const query = safeString(deferredInputValue).toLowerCase();

    return FIELD_CATEGORIES.map((category) => {
      const categoryOptions = translatedFields
        .filter((field) => field.category === category.value)
        .filter((field) => (query ? field.searchableText.includes(query) : true))
        .slice(0, MAX_OPTIONS_PER_CATEGORY)
        .map((field) => ({
          value: field.value,
          label: field.translatedLabel,
        }));

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
  }, [deferredInputValue, translatedFields, t]);

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

      onFieldChange(fieldByValue.get(nextValue) || null);
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
        autoComplete="off"
        disabled={disabled}
      />
    ),
    [disabled, handleInputChange, inputValue, t]
  );

  const isDisabled = disabled || allFields.length === 0;

  return (
    <BlockStack gap="150">
      <Autocomplete
        options={options}
        selected={selected}
        onSelect={handleSelect}
        textField={textField}
        disabled={isDisabled}
      />

      <Box minHeight="20px">
        {selectedFieldDefinition ? (
          <Text
            as="p"
            variant="bodySm"
            tone={
              selectedFieldDefinition.requiresConfirmation
                ? "critical"
                : "subdued"
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
