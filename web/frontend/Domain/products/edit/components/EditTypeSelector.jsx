import React, { memo, useCallback, useMemo } from "react";
import { Select } from "@shopify/polaris";
import { useTranslation } from "react-i18next";
import { getFieldActions } from "../constants";

function safeString(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  const stringValue = String(value).trim();
  return stringValue || fallback;
}

function normalizeActionOptions(rawOptions) {
  if (!Array.isArray(rawOptions)) return [];

  const seenValues = new Set();
  const normalized = [];

  for (const option of rawOptions) {
    const value = safeString(option?.value);
    const defaultLabel = safeString(
      option?.defaultLabel || option?.label,
      value,
    );
    const labelKey = safeString(option?.labelKey);

    if (!value || !defaultLabel || !labelKey) {
      if (import.meta.env.DEV) {
        console.warn("Invalid edit action definition.", option);
      }
      continue;
    }

    if (seenValues.has(value)) {
      if (import.meta.env.DEV) {
        console.warn(`Duplicate edit action value: ${value}`);
      }
      continue;
    }

    seenValues.add(value);
    normalized.push({
      ...option,
      value,
      labelKey,
      defaultLabel,
    });
  }

  return normalized;
}

function resolveEditTypeValue(editType) {
  if (typeof editType === "string") {
    return safeString(editType);
  }
  return safeString(editType?.value);
}

function EditTypeSelector({
  selectedFieldValue,
  editType,
  onEditTypeChange,
  disabled = false,
}) {
  const { t } = useTranslation(["products", "common"]);
  const normalizedSelectedFieldValue = safeString(selectedFieldValue);

  const editOptions = useMemo(() => {
    if (!normalizedSelectedFieldValue) return [];
    return normalizeActionOptions(getFieldActions(normalizedSelectedFieldValue));
  }, [normalizedSelectedFieldValue]);

  const optionByValue = useMemo(
    () => new Map(editOptions.map((option) => [option.value, option])),
    [editOptions],
  );

  const rawSelectedValue = resolveEditTypeValue(editType);
  const selectedValue = optionByValue.has(rawSelectedValue)
    ? rawSelectedValue
    : "";

  const options = useMemo(() => {
    const placeholder = {
      label: t("products:selectEditTypePlaceholder", {
        defaultValue: "Select how to edit",
      }),
      value: "",
    };

    return [
      placeholder,
      ...editOptions.map((option) => ({
        label: t(option.labelKey, { defaultValue: option.defaultLabel }),
        value: option.value,
      })),
    ];
  }, [editOptions, t]);

  const handleChange = useCallback(
    (value) => {
      if (typeof onEditTypeChange !== "function") return;
      onEditTypeChange(value || null);
    },
    [onEditTypeChange],
  );

  const isDisabled =
    disabled || !normalizedSelectedFieldValue || editOptions.length === 0;
  const helpText = !normalizedSelectedFieldValue
    ? t("products:selectFieldBeforeEditType", {
        defaultValue: "Select a field before choosing how to edit.",
      })
    : editOptions.length === 0
      ? t("products:noEditActionsAvailable", {
          defaultValue: "No edit actions are available for this field.",
        })
      : undefined;

  return (
    <Select
      label={t("products:howToEdit", { defaultValue: "How to edit" })}
      options={options}
      value={selectedValue}
      onChange={handleChange}
      disabled={isDisabled}
      helpText={helpText}
    />
  );
}

export default memo(EditTypeSelector);
