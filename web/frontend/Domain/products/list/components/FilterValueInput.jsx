import React, { memo, useCallback, useMemo } from "react";
import {
  ChoiceList,
  TextField,
  Autocomplete,
} from "@shopify/polaris";

const VALID_INPUT_MODES = new Set([
  "none",
  "text",
  "decimal",
  "numeric",
  "tel",
  "search",
  "email",
  "url",
]);

const DATE_VALUE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizeNumberConstraint(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === "string" && value.trim() !== "") {
    return Number.isFinite(Number(value)) ? value : undefined;
  }

  return undefined;
}

function normalizeDateConstraint(value) {
  return typeof value === "string" && DATE_VALUE_PATTERN.test(value)
    ? value
    : undefined;
}

function normalizeInputMode(inputMode) {
  return VALID_INPUT_MODES.has(inputMode) ? inputMode : undefined;
}

function normalizeSelectedValues(value) {
  if (Array.isArray(value)) {
    return value.filter((entry) => entry !== undefined && entry !== null);
  }

  return value ? [value] : [];
}

const FilterValueInput = memo(function FilterValueInput({
  filter,
  value,
  inputText,
  onChange,
  onSearch,
  options,
  loading,
  placeholder,
  enumChoices,
  hasSearched = false,
  allowEmptySearchPreload = false,
  noSuggestionsText,
  error = null,
}) {
  const normalizedInputText = String(inputText || "");
  const selectedValues = useMemo(() => normalizeSelectedValues(value), [value]);
  const numberConstraints = useMemo(
    () => ({
      min: normalizeNumberConstraint(filter.min),
      max: normalizeNumberConstraint(filter.max),
      step: normalizeNumberConstraint(filter.step),
      inputMode: normalizeInputMode(filter.inputMode),
    }),
    [filter.inputMode, filter.max, filter.min, filter.step],
  );
  const dateConstraints = useMemo(
    () => ({
      min: normalizeDateConstraint(filter.minDate),
      max: normalizeDateConstraint(filter.maxDate),
    }),
    [filter.maxDate, filter.minDate],
  );
  const handleAutocompleteFocus = useCallback(() => {
    if (normalizedInputText.trim().length > 0 || allowEmptySearchPreload) {
      onSearch(normalizedInputText);
    }
  }, [allowEmptySearchPreload, normalizedInputText, onSearch]);
  const handleAutocompleteSelect = useCallback(
    ([selected]) => {
      const option = options.find((entry) => entry.value === selected);
      onChange(selected, option?.label || selected || "");
    },
    [onChange, options],
  );
  const handleChoiceChange = useCallback(
    (selected) => {
      if (filter.allowMultiple) {
        onChange(selected, selected.join(", "));
        return;
      }

      const [next] = selected;
      onChange(next, next);
    },
    [filter.allowMultiple, onChange],
  );
  const emptyState = useMemo(() => {
    if (loading || error || !hasSearched || options.length > 0) return null;

    return noSuggestionsText || null;
  }, [error, hasSearched, loading, noSuggestionsText, options.length]);

  if (filter.type === "enum") {
    return (
      <ChoiceList
        titleHidden
        choices={enumChoices}
        selected={selectedValues}
        allowMultiple={Boolean(filter.allowMultiple)}
        onChange={handleChoiceChange}
      />
    );
  }

  if (filter.isSearchable) {
    return (
      <Autocomplete
        options={options}
        selected={selectedValues}
        loading={loading}
        onSelect={handleAutocompleteSelect}
        emptyState={emptyState}
        textField={
          <Autocomplete.TextField
            labelHidden
            placeholder={placeholder}
            autoComplete="off"
            value={normalizedInputText}
            error={error ?? undefined}
            onFocus={handleAutocompleteFocus}
            onChange={onSearch}
          />
        }
      />
    );
  }

  if (filter.type === "number") {
    return (
      <TextField
        type="number"
        labelHidden
        value={value}
        min={numberConstraints.min}
        max={numberConstraints.max}
        step={numberConstraints.step}
        inputMode={numberConstraints.inputMode}
        error={error ?? undefined}
        onChange={(next) => onChange(next, next)}
      />
    );
  }

  if (filter.type === "date") {
    return (
      <TextField
        type="date"
        labelHidden
        value={value}
        min={dateConstraints.min}
        max={dateConstraints.max}
        error={error ?? undefined}
        onChange={(next) => onChange(next, next)}
      />
    );
  }

  return (
    <TextField
      labelHidden
      value={value}
      inputMode={normalizeInputMode(filter.inputMode)}
      error={error ?? undefined}
      onChange={(next) => onChange(next, next)}
    />
  );
});

export default FilterValueInput;
