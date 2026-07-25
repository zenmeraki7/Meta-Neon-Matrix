import React, {
  memo,
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
} from "react";
import {
  Box,
  BlockStack,
  Select,
  Button,
  InlineStack,
  Text,
} from "@shopify/polaris";
import FilterValueInput from "./FilterValueInput";
import {
  operatorRequiresValue,
  getTranslatedOperatorLabel,
  normalizeAutocompleteOption,
} from "../utils/filterUtils";
import { useApiClient } from "../../../../hooks/useApiClient";

const MIN_AUTOCOMPLETE_QUERY_LENGTH = 2;

function normalizeMinQueryLength(value) {
  return Number.isInteger(value) && value >= 0
    ? value
    : MIN_AUTOCOMPLETE_QUERY_LENGTH;
}

function hasDraftValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return String(value || "").trim().length > 0;
}

async function fetchAutocompleteOptions({
  api,
  filter,
  query,
  signal,
  setOptions,
  setLoading,
}) {
  if (!filter.api) return;

  setLoading(true);

  try {
    const data = await api.get(
      `${filter.api}?search=${encodeURIComponent(query)}&isNameOnly=true`,
      {
        headers: { Accept: "application/json" },
        signal,
      },
    );
    if (signal.aborted) return;

    const items = Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data)
        ? data
        : [];

    setOptions(items.map(normalizeAutocompleteOption).filter(Boolean));
  } catch (error) {
    if (error?.name !== "AbortError") {
      console.error("Autocomplete error", { filter: filter.key, error });
      setOptions([]);
    }
  } finally {
    if (!signal.aborted) setLoading(false);
  }
}

const FilterPanel = memo(function FilterPanel({
  filter,
  initialFilter,
  onApply,
  onCancel,
  cancelLabel,
  t,
}) {
  const api = useApiClient();
  const [draft, setDraft] = useState({
    operator: initialFilter?.operator || filter.operators[0] || "",
    value: initialFilter?.value || "",
    inputText: initialFilter?.value || "",
  });

  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  const debounceTimer = useRef(null);
  const abortControllerRef = useRef(null);

  // Reset when filter changes
  useEffect(() => {
    setDraft({
      operator: initialFilter?.operator || filter.operators[0] || "",
      value: initialFilter?.value || "",
      inputText: initialFilter?.value || "",
    });
    setOptions([]);
    setLoading(false);
    setHasSearched(false);
  }, [filter.key, initialFilter]);

  // Cleanup
  useEffect(() => {
    return () => {
      clearTimeout(debounceTimer.current);
      abortControllerRef.current?.abort();
    };
  }, []);

  // Sync label after selection
  useEffect(() => {
    if (!filter.isSearchable || !draft.value) return;

    const match = options.find((o) => o.value === draft.value);
    if (match?.label && match.label !== draft.inputText) {
      setDraft((prev) => ({ ...prev, inputText: match.label }));
    }
  }, [options, draft.value, draft.inputText, filter.isSearchable]);

  // Memoized operator labels
  const operatorOptions = useMemo(
    () =>
      filter.operators.map((op) => ({
        label: getTranslatedOperatorLabel(t, op),
        value: op,
      })),
    [filter.operators, t]
  );

  // Placeholder (only dynamic part)
  const placeholder = useMemo(
    () =>
      t("searchPlaceholderField", {
        field: filter.translatedLabel || filter.label,
      }),
    [t, filter.translatedLabel, filter.label]
  );

  const noSuggestionsText = useMemo(
    () =>
      t("noSuggestionsForField", {
        field: filter.translatedLabel || filter.label,
        defaultValue: t("noSuggestions", "No suggestions found"),
      }),
    [t, filter.translatedLabel, filter.label]
  );

  const minQueryLength = useMemo(
    () => normalizeMinQueryLength(filter.minQueryLength),
    [filter.minQueryLength]
  );

  const allowEmptySearchPreload = Boolean(filter.allowEmptySearchPreload);
  const allowFreeText = filter.allowFreeText !== false;

  // Enum labels
  const enumChoices = useMemo(() => {
    if (filter.type !== "enum") return [];
    return filter.values.map((entry) => ({
      label: t(`filterValueLabels.${entry}`, entry),
      value: entry,
    }));
  }, [filter.type, filter.values, t]);

  const handleSearch = useCallback(
    (query) => {
      const q = String(query || "").trimStart();

      setDraft((prev) => ({
        ...prev,
        inputText: query,
        value: allowFreeText ? q : "",
      }));

      clearTimeout(debounceTimer.current);
      abortControllerRef.current?.abort();

      if (!allowEmptySearchPreload && q.length < minQueryLength) {
        setOptions([]);
        setLoading(false);
        setHasSearched(false);
        return;
      }

      if (allowEmptySearchPreload && q.length === 0) {
        const controller = new AbortController();
        abortControllerRef.current = controller;
        setHasSearched(true);

        fetchAutocompleteOptions({
          api,
          filter,
          query: "",
          signal: controller.signal,
          setOptions,
          setLoading,
        });
        return;
      }

      debounceTimer.current = setTimeout(() => {
        const controller = new AbortController();
        abortControllerRef.current = controller;
        setHasSearched(true);

        fetchAutocompleteOptions({
          api,
          filter,
          query: q,
          signal: controller.signal,
          setOptions,
          setLoading,
        });
      }, 300);
    },
    [allowEmptySearchPreload, allowFreeText, api, filter, minQueryLength]
  );

  const handleValueChange = useCallback((val, text = val) => {
    setDraft((prev) => ({
      ...prev,
      value: val,
      inputText: text,
    }));
  }, []);

  const handleOperatorChange = useCallback((op) => {
    setDraft((prev) => ({ ...prev, operator: op }));
  }, []);

  const handleApply = useCallback(() => {
    onApply({
      field: filter.key,
      operator: draft.operator,
      value: draft.value,
    });
  }, [filter.key, draft, onApply]);

  return (
    <Box width="280px" padding="200">
      <BlockStack gap="300">
        <Text as="p" variant="bodySm" tone="subdued">
          {t("configureField", {
            field: filter.translatedLabel || filter.label,
          })}
        </Text>

        {filter.operators.length > 0 && (
          <Select
            labelHidden
            options={operatorOptions}
            value={draft.operator}
            onChange={handleOperatorChange}
          />
        )}

        <FilterValueInput
          filter={filter}
          value={draft.value}
          inputText={draft.inputText}
          options={options}
          loading={loading}
          placeholder={placeholder}
          enumChoices={enumChoices}
          hasSearched={hasSearched}
          allowEmptySearchPreload={allowEmptySearchPreload}
          noSuggestionsText={noSuggestionsText}
          onChange={handleValueChange}
          onSearch={handleSearch}
        />

        <InlineStack gap="200" align="end">
          <Button onClick={onCancel}>
            {cancelLabel || t("cancel", "Cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={
              operatorRequiresValue(draft.operator)
                ? !hasDraftValue(draft.value)
                : false
            }
            onClick={handleApply}
          >
            {t("addFilter")}
          </Button>
        </InlineStack>
      </BlockStack>
    </Box>
  );
});

export default FilterPanel;
