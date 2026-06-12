// ValueInput.jsx
import React, {
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  TextField,
  FormLayout,
  ChoiceList,
  Select,
  Autocomplete,
  Icon,
  Text,
  Banner,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";
import { useTranslation } from "react-i18next";
import {
  FieldType,
  getFieldDefinition,
  InputType,
  OperationKind,
  ValueKind,
} from "../constants";
import { useFieldValidation } from "../hooks/useFiledValidation";
import { getValueValidationRules } from "../../../../utils/valueValidation";
import { useApiClient } from "../../../../hooks/useApiClient";
import { toSafeErrorMessage } from "../../../../utils/frontendError";

const AUTOCOMPLETE_RESULT_LIMIT = 25;
const REFERENCE_DATA_STALE_TIME = 5 * 60 * 1000;
const AUTOCOMPLETE_OFF = "off";
const POLARIS_TONE_CRITICAL = "critical";
const TEXT_AS_P = "p";
const NUMERIC_PATTERNS = {
  money: /^\d{1,9}(\.\d{0,2})?$/,
  inventory: /^\d{1,7}$/,
  percentage: /^\d{1,3}(\.\d{0,2})?$/,
  number: /^\d{1,12}(\.\d{0,4})?$/,
};
const MONEY_FIELDS = new Set(["price", "compareAtPrice", "cost"]);
const INVENTORY_FIELDS = new Set([
  "inventory",
  "inventoryQuantity",
  "inventory_quantity",
  "available",
  "quantity",
]);

function getArrayPayload(json) {
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json)) return json;
  return [];
}

function getNumericKind(fieldValue, isPercentage) {
  if (isPercentage) return "percentage";
  if (MONEY_FIELDS.has(fieldValue)) return "money";
  if (INVENTORY_FIELDS.has(fieldValue)) return "inventory";
  return "number";
}

const ValueInput = ({
  selectedField,
  editType,
  value,
  onChange,
  searchReplace,
  onSearchReplaceChange,
  locationValue,
  onLocationChange,
  setSupportValue,
  confirmationValue = "",
  onConfirmationChange,
}) => {
  const { t } = useTranslation();
  const api = useApiClient();
  const [helperText, setHelperText] = useState("");

  // State for autocomplete
  const [autocompleteInputValue, setAutocompleteInputValue] = useState("");
  const [debouncedAutocompleteQuery, setDebouncedAutocompleteQuery] =
    useState("");
  const [hasAutocompleteFocused, setHasAutocompleteFocused] = useState(false);
  // Update the state for autocomplete to track multiple selections
  const [selectedOptions, setSelectedOptions] = useState([]);

  // Debounce ref
  const debounceTimerRef = useRef(null);

  const fieldDef = getFieldDefinition(selectedField?.value);
  const inputType = editType?.inputType || InputType.SINGLE;
  const config = editType || {};
  const allowMultiple = config.allowMultiple || false;
  const resourceLabelKey = config.resourceLabelKey || "label";
  const resourceValueKey = config.resourceValueKey || config.valueKey || "value";
  const searchValue = searchReplace?.search?.trim() || "";
  const replaceValue = searchReplace?.replace ?? "";
  const searchReplaceError =
    inputType === InputType.SEARCH_REPLACE && searchValue.length === 0
      ? t("errors.searchValueRequired", {
          defaultValue: "Search value is required.",
        })
      : undefined;

  const isPercentage = editType?.valueKind === ValueKind.PERCENTAGE;
  const isNumeric = fieldDef?.type === FieldType.NUMERIC;
  const isFixedValue =
    isNumeric &&
    editType?.operationKind === OperationKind.SET &&
    editType?.valueKind === ValueKind.FIXED_AMOUNT;
  const numericKind = getNumericKind(fieldDef?.value, isPercentage);
  const maxPercentage = Number(editType?.maxPercentage ?? editType?.max ?? 100);

  useEffect(() => {
    setHelperText("");
  }, [selectedField, editType]);

  useEffect(() => {
    if (autocompleteInputValue && typeof setSupportValue === "function") {
      setSupportValue(autocompleteInputValue);
    }
  }, [autocompleteInputValue, setSupportValue]);
  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const locationsQuery = useQuery({
    queryKey: ["locations"],
    enabled: inputType === InputType.LOCATION_SELECT,
    staleTime: REFERENCE_DATA_STALE_TIME,
    queryFn: async ({ signal }) => {
      const json = await api.get("/api/location/get-all", { signal });
      return getArrayPayload(json).map((loc) => ({
        label: String(loc?.title ?? loc?.label ?? ""),
        value: String(loc?.id ?? loc?.value ?? ""),
      })).filter((loc) => loc.value);
    },
  });

  const apiLocations = locationsQuery.data || [];

  useEffect(() => {
    if (locationsQuery.error) {
      setHelperText(
        toSafeErrorMessage(t, locationsQuery.error, "common.errors.generic"),
      );
    }
  }, [locationsQuery.error, t]);

  useEffect(() => {
    if (
      !locationValue &&
      apiLocations.length === 1 &&
      typeof onLocationChange === "function"
    ) {
      onLocationChange(apiLocations[0].value);
    }
  }, [apiLocations, locationValue, onLocationChange]);

  const normalizedAutocompleteQuery = String(debouncedAutocompleteQuery || "").trim();
  const shouldFetchAutocomplete =
    inputType === InputType.API_AUTOCOMPLETE &&
    Boolean(config.apiEndpoint) &&
    hasAutocompleteFocused &&
    (normalizedAutocompleteQuery.length === 0 ||
      normalizedAutocompleteQuery.length >= 2);

  const autocompleteQuery = useQuery({
    queryKey: [
      "autocomplete",
      config.apiEndpoint || "",
      resourceValueKey,
      resourceLabelKey,
      normalizedAutocompleteQuery,
    ],
    enabled: shouldFetchAutocomplete,
    staleTime: REFERENCE_DATA_STALE_TIME,
    queryFn: async ({ signal }) => {
        const params = new URLSearchParams({
          isNameOnly: "true",
          limit: String(AUTOCOMPLETE_RESULT_LIMIT),
        });

        if (normalizedAutocompleteQuery) {
          params.set("search", normalizedAutocompleteQuery);
        }

      const separator = config.apiEndpoint.includes("?") ? "&" : "?";
      const url = `${config.apiEndpoint}${separator}${params.toString()}`;

      const json = await api.get(url, { signal });
      const rawItems = getArrayPayload(json);

      return rawItems.slice(0, AUTOCOMPLETE_RESULT_LIMIT).map((item) => ({
          value: String(item[resourceValueKey]),
          label: String(item[resourceLabelKey] ?? ""),
      }));
    },
  });

  const autocompleteOptions = autocompleteQuery.data || [];

  useEffect(() => {
    if (autocompleteQuery.error) {
      setHelperText(
        toSafeErrorMessage(t, autocompleteQuery.error, "common.errors.generic"),
      );
    }
  }, [autocompleteQuery.error, t]);

  useEffect(() => {
    setSelectedOptions([]);
    setAutocompleteInputValue("");
    setDebouncedAutocompleteQuery("");
    setHasAutocompleteFocused(false);
  }, [selectedField?.value, editType?.value]);

  useEffect(() => {
    if (inputType !== InputType.API_AUTOCOMPLETE) {
      return;
    }

    const rawValue = value == null ? "" : String(value).trim();

    if (!rawValue) {
      return;
    }

    const values = allowMultiple
      ? rawValue
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [rawValue];

    setSelectedOptions(values);

    const labels = values.map((selectedValue) => {
      const matchedOption = autocompleteOptions.find(
        (option) => option.value === selectedValue,
      );

      return matchedOption?.label || selectedValue;
    });

    setAutocompleteInputValue(labels.join(", "));
  }, [
    allowMultiple,
    autocompleteOptions,
    inputType,
    selectedField?.value,
    editType?.value,
    value,
  ]);

  const validationRules = useMemo(
    () =>
      getValueValidationRules(isPercentage, isFixedValue, {
        numericKind,
        maxPercentage,
      }),
    [isPercentage, isFixedValue, maxPercentage, numericKind]
  );

  const error = useFieldValidation(value, validationRules);

  const handleChange = (val) => {
    if (typeof val !== "string") return;

    setHelperText("");

    if (isNumeric) {
      if (val.trim() === "") {
        onChange("");
        return;
      }

      const pattern = NUMERIC_PATTERNS[numericKind] || NUMERIC_PATTERNS.number;

      if (!pattern.test(val)) {
        setHelperText(
          t("errors.invalidNumericValue", {
            defaultValue:
              numericKind === "money"
                ? "Enter a valid price."
                : numericKind === "percentage"
                  ? "Enter a valid percentage."
                  : "Enter a valid amount.",
          }),
        );
        return;
      }

      const numericValue = Number(val);

      if (!Number.isFinite(numericValue)) {
        setHelperText(
          t("errors.invalidNumericValue", {
            defaultValue:
              numericKind === "money"
                ? "Enter a valid price."
                : numericKind === "percentage"
                  ? "Enter a valid percentage."
                  : "Enter a valid amount.",
          }),
        );
        return;
      }

      if (isPercentage && numericValue > maxPercentage) {
        setHelperText(
          t("errors.percentageTooLarge", {
            max: maxPercentage,
            defaultValue: `Percentage cannot be greater than ${maxPercentage}.`,
          }),
        );
        return;
      }
    }

    onChange(val);
  };

  const getLabel = () => {
    if (editType?.operationKind === OperationKind.DECREASE)
      return t("DecreaseValue");

    if (editType?.operationKind === OperationKind.INCREASE)
      return t("IncreaseValue");

    if (editType?.operationKind === OperationKind.SET)
      return t("new_value");

    return config.inputHelperLabel
      ? t(config.inputHelperLabel)
      : t("value");
  };

  // Autocomplete handlers with proper debounce
  const updateAutocompleteText = useCallback(
    (newValue) => {
      setAutocompleteInputValue(newValue);

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      debounceTimerRef.current = setTimeout(() => {
        setDebouncedAutocompleteQuery(newValue);
      }, 500);
    },
    []
  );

  const updateSelection = useCallback(
    (selected) => {
      if (allowMultiple) {
        // Multiple selection mode
        setSelectedOptions(selected);

        // Get labels for display
        const selectedLabels = selected
          .map((selectedItem) => {
            const matchedOption = autocompleteOptions.find((option) => {
              return option.value === selectedItem;
            });
            return matchedOption?.label;
          })
          .filter(Boolean);

        setAutocompleteInputValue(selectedLabels.join(", "));

        // Pass array of IDs for multiple selection
        onChange(selected.join(","));

        // Set support value with collection names for display
        setSupportValue && setSupportValue(selectedLabels.join(", "));
      } else {
        // Single selection mode (existing logic)
        const selectedValue = selected.map((selectedItem) => {
          const matchedOption = autocompleteOptions.find((option) => {
            return option.value === selectedItem;
          });
          return matchedOption && matchedOption.label;
        });

        setSelectedOptions(selected);
        setAutocompleteInputValue(selectedValue[0] || "");
        onChange(selected[0] || "");

        // Set support value with category name for display
        setSupportValue && setSupportValue(selectedValue[0] || "");
      }
    },
    [autocompleteOptions, onChange, allowMultiple, setSupportValue]
  );

  const autocompleteTextField = (
    <Autocomplete.TextField
      onChange={updateAutocompleteText}
      onFocus={() => {
        setHasAutocompleteFocused(true);
        setDebouncedAutocompleteQuery(autocompleteInputValue);
      }}
      label={
        config.inputHelperLabel
          ? t(config.inputHelperLabel)
          : t("selectCategory")
      }
      value={autocompleteInputValue}
      prefix={<Icon source={SearchIcon} />}
      placeholder={
        allowMultiple
          ? t("search_multiple", { defaultValue: "Search and select multiple..." })
          : t("search", { defaultValue: "Search..." })
      }
      autoComplete={AUTOCOMPLETE_OFF}
      error={helperText}
    />
  );

  switch (inputType) {
    case InputType.CHOICE_LIST:
      return (
        <ChoiceList
          title={t(editType?.inputHelperLabel || "Select Option", {
            defaultValue: editType?.inputHelperLabel || "Select Option",
          })}
          choices={(config.choices || []).map((choice) => ({
            ...choice,
            label: t(choice.label, { defaultValue: choice.label }),
          }))}
          selected={
            value !== undefined && value !== null ? [String(value)] : []
          }
          onChange={(selected) => onChange(selected[0] ?? "")}
        />
      );

    case InputType.SEARCH_REPLACE:
      return (
        <FormLayout>
          <FormLayout.Group condensed>
            <TextField
              label={
                config.searchLabel
                  ? t(config.searchLabel)
                  : t("searchFor")
              }
              value={
                typeof searchReplace?.search === "string"
                  ? searchReplace.search
                  : ""
              }
              onChange={(val) =>
                onSearchReplaceChange?.({
                  search: val,
                  replace: replaceValue,
                })
              }
              error={searchReplaceError}
              autoComplete={AUTOCOMPLETE_OFF}
            />

            <TextField
              label={
                config.replaceLabel
                  ? t(config.replaceLabel)
                  : t("replaceWith")
              }
              value={
                typeof searchReplace?.replace === "string"
                  ? searchReplace.replace
                  : ""
              }
              onChange={(val) =>
                onSearchReplaceChange?.({
                  search: searchValue,
                  replace: val,
                })
              }
              autoComplete={AUTOCOMPLETE_OFF}
            />
          </FormLayout.Group>
        </FormLayout>
      );

    case InputType.LOCATION_SELECT:
      return (
        <FormLayout>
          <TextField
            label={getLabel()}
            value={typeof value === "string" ? value : ""}
            onChange={handleChange}
            error={helperText || error}
            autoComplete={AUTOCOMPLETE_OFF}
          />
          <Select
            label={t("location", { defaultValue: "Location" })}
            options={[
              {
                label: t("selectLocation", { defaultValue: "Select a location" }),
                value: "",
                disabled: true,
              },
              ...apiLocations,
            ]}
            value={locationValue || ""}
            onChange={onLocationChange}
            disabled={apiLocations.length === 0}
          />
        </FormLayout>
      );

    // API-driven autocomplete with debounce
    case InputType.API_AUTOCOMPLETE:
      return (
        <Autocomplete
          options={autocompleteOptions}
          selected={selectedOptions}
          onSelect={updateSelection}
          loading={autocompleteQuery.isFetching}
          textField={autocompleteTextField}
          allowMultiple={allowMultiple}
        />
      );

    case InputType.NONE:
      return (
        <FormLayout>
          <Banner tone={POLARIS_TONE_CRITICAL}>
            <Text as={TEXT_AS_P}>
              {editType?.inputHelperLabel
                ? t(editType.inputHelperLabel)
                : t("permanentAction")}
            </Text>
          </Banner>
          {config.requiresConfirmation === true && (
            <TextField
              label={t("typeConfirm", {
                defaultValue: "Type CONFIRM to continue",
              })}
              value={confirmationValue}
              onChange={onConfirmationChange}
              error={
                confirmationValue && confirmationValue !== "CONFIRM"
                  ? t("errors.confirmationMismatch", {
                      defaultValue: "You must type CONFIRM exactly.",
                    })
                  : undefined
              }
              autoComplete={AUTOCOMPLETE_OFF}
            />
          )}
        </FormLayout>
      );

    default:
      return (
        <TextField
          label={getLabel()}
          value={typeof value === "string" ? value : ""}
          onChange={handleChange}
          error={helperText || error}
          autoComplete={AUTOCOMPLETE_OFF}
        />
      );
  }
};

export default ValueInput;
