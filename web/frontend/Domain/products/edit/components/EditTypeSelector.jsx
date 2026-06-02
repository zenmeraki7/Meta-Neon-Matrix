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
    const label = safeString(option?.label);

    if (!value || !label || seenValues.has(value)) continue;

    seenValues.add(value);
    normalized.push({
      ...option,
      value,
      label,
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
  selectedField,
  editType,
  onEditTypeChange,
  disabled = false,
}) {
  const { t } = useTranslation(["products", "common"]);

  const selectedFieldValue = safeString(selectedField?.value);

  const editOptions = useMemo(() => {
    if (!selectedFieldValue) return [];
    return normalizeActionOptions(getFieldActions(selectedFieldValue));
  }, [selectedFieldValue]);

  const optionValues = useMemo(
    () => new Set(editOptions.map((option) => option.value)),
    [editOptions],
  );

  const rawSelectedValue = resolveEditTypeValue(editType);
  const selectedValue = optionValues.has(rawSelectedValue) ? rawSelectedValue : "";

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
        label: t(option.label, { defaultValue: option.label }),
        value: option.value,
      })),
    ];
  }, [editOptions, t]);

  const handleChange = useCallback(
    (value) => {
      if (typeof onEditTypeChange !== "function") return;

      if (!value) {
        onEditTypeChange(null);
        return;
      }

      const selected = editOptions.find((option) => option.value === value);
      onEditTypeChange(selected || null);
    },
    [editOptions, onEditTypeChange],
  );

  const isDisabled = disabled || !selectedFieldValue || editOptions.length === 0;

  return (
    <Select
      label={t("products:HowToEdit", { defaultValue: "How to edit" })}
      options={options}
      value={selectedValue}
      onChange={handleChange}
      disabled={isDisabled}
    />
  );
}

export default memo(EditTypeSelector);
