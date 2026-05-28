import React, { memo, useCallback, useMemo } from "react";
import { Select } from "@shopify/polaris";
import { useTranslation } from "react-i18next";

const DEFAULT_ROUNDING_VALUE = "NONE";

const ROUNDING_OPTIONS = Object.freeze([
  {
    labelKey: "products:rounding.none",
    defaultLabel: "Don't round the value",
    value: "NONE",
  },
  {
    labelKey: "products:rounding.nearestWhole",
    defaultLabel: "Round to nearest whole number",
    value: "NEAREST_WHOLE",
  },
  {
    labelKey: "products:rounding.twoDecimals",
    defaultLabel: "Round to 2 decimal places",
    value: "TWO_DECIMALS",
  },
]);

const ROUNDING_OPTION_VALUES = new Set(
  ROUNDING_OPTIONS.map((option) => option.value),
);

function safeString(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  const stringValue = String(value).trim();
  return stringValue || fallback;
}

function normalizeRoundingValue(value) {
  const normalized = safeString(value);
  return ROUNDING_OPTION_VALUES.has(normalized)
    ? normalized
    : DEFAULT_ROUNDING_VALUE;
}

function supportsRounding(selectedField) {
  return selectedField?.supportsRounding === true;
}

function RoundingSelector({
  selectedField,
  rounding,
  onRoundingChange,
  disabled = false,
}) {
  const { t } = useTranslation(["products", "common"]);

  const shouldRender = supportsRounding(selectedField);
  const selectedValue = normalizeRoundingValue(rounding);

  const options = useMemo(
    () =>
      ROUNDING_OPTIONS.map((option) => ({
        label: t(option.labelKey, {
          defaultValue: option.defaultLabel,
        }),
        value: option.value,
      })),
    [t],
  );

  const handleChange = useCallback(
    (value) => {
      if (typeof onRoundingChange !== "function") return;
      onRoundingChange(normalizeRoundingValue(value));
    },
    [onRoundingChange],
  );

  if (!shouldRender) return null;

  return (
    <Select
      label={t("products:rounding.label", { defaultValue: "Rounding" })}
      options={options}
      value={selectedValue}
      onChange={handleChange}
      disabled={disabled}
    />
  );
}

export default memo(RoundingSelector);

