import React, {
  useState,
  useCallback,
  useMemo,
  useEffect,
} from "react";
import {
  Page,
  Layout,
  Card,
  FormLayout,
  BlockStack,
  Box,
  Text,
  Banner,
  InlineStack,
  Badge,
  Modal,
  TextField,
} from "@shopify/polaris";
import { ChevronLeftIcon } from "@shopify/polaris-icons";
import { useSelector } from "react-redux";
import { useNavigate } from "react-router-dom";
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
import FieldSelector from "../components/FieldSelector";
import EditTypeSelector from "../components/EditTypeSelector";
import ValueInput from "../components/ValueInput";
import PreviewTable from "../components/PreviewTable";
import ScheduleEdit from "../components/ScheduleEdit";
import RecurringEditModal from "../components/RecurringEditModal";
import { useFilterRegistry } from "../../list/hooks/useFilterRegistry";
import {
  selectFilters,
  selectSearch,
} from "../../../../store/slices/productSlice";
import useProductSyncStatus from "../../../../hooks/useProductSyncStatus";
import { toSafeErrorMessage } from "../../../../utils/frontendError";
import { useToast as useAppToast } from "../../../../components/providers/ToastProvider";
import MirrorFreshnessBadge from "../../../../components/MirrorFreshnessBadge";
import useDebouncedValue from "../../../../hooks/useDebouncedValue";
import { protectedApiPost } from "../../../../api/protectedApiClient";
import {
  createEditPreviewPayloadHash,
  useEditPreviewQuery,
  usePreviewQueryInput,
} from "../hooks/useEditPreviewQuery";

const MONEY_FIELDS = new Set(["price", "compareAtPrice", "cost"]);
const INVENTORY_FIELDS = new Set([
  "inventory",
  "inventoryQuantity",
  "inventory_quantity",
  "available",
  "quantity",
]);
const EMPTY_PREVIEW_ROWS = Object.freeze([]);
const DEFAULT_CONFIRMATION_PHRASE = "CONFIRM";
const POLARIS_TONE_INFO = "info";
const POLARIS_TONE_CRITICAL = "critical";
const POLARIS_TONE_WARNING = "warning";
const POLARIS_TONE_ATTENTION = "attention";
const POLARIS_TONE_SUBDUED = "subdued";
const TEXT_BODY_MD = "bodyMd";
const TEXT_BODY_SM = "bodySm";
const TEXT_HEADING_MD = "headingMd";
const TEXT_AS_H2 = "h2";
const TEXT_AS_H3 = "h3";
const TEXT_AS_P = "p";
const TEXT_AS_SPAN = "span";
const GAP_100 = "100";
const GAP_200 = "200";
const GAP_300 = "300";
const GAP_400 = "400";
const PADDING_500 = "500";
const PADDING_BLOCK_END_300 = "300";
const LAYOUT_ONE_THIRD = "oneThird";
const INLINE_BLOCK_ALIGN_CENTER = "center";
const AUTOCOMPLETE_OFF = "off";

function getNumericKind(fieldValue, isPercentage) {
  if (isPercentage) return "percentage";
  if (MONEY_FIELDS.has(fieldValue)) return "money";
  if (INVENTORY_FIELDS.has(fieldValue)) return "inventory";
  return "number";
}

function resolveFieldSelection(selection) {
  const fieldValue =
    typeof selection === "string" ? selection : selection?.value;
  const canonicalField = getFieldDefinition(fieldValue);

  if (!canonicalField) return null;

  return {
    ...canonicalField,
    ...(typeof selection === "object" && selection ? selection : {}),
  };
}

function resolveEditTypeSelection(selectedField, selection) {
  const actionValue =
    typeof selection === "string" ? selection : selection?.value;
  const actions = Array.isArray(selectedField?.actions)
    ? selectedField.actions
    : [];

  return actions.find((action) => action?.value === actionValue) || null;
}

export default function EditPreviewPage() {
  const filters = useSelector(selectFilters);
  const search = useSelector(selectSearch);
  const navigate = useNavigate();
  const { i18n, t } = useTranslation();
  const { isSyncInProgress } = useProductSyncStatus();
  const { showSuccess, showError } = useAppToast();
  const {
    versions: filterRegistryVersions,
    fallbackReason: filterRegistryFallbackReason,
  } = useFilterRegistry();
  const isFilterRegistryDegraded =
    filterRegistryFallbackReason === "error" ||
    filterRegistryFallbackReason === "malformed";

  const [selectedField, setSelectedField] = useState(getFieldDefinition("price"));
  const [editTypeValue, setEditTypeValue] = useState(null);
  const [rounding, setRounding] = useState("NONE");
  const [draftInputValue, setDraftInputValue] = useState(null);
  const [inputValue, setInputValue] = useState(null);
  const [draftSearchReplace, setDraftSearchReplace] = useState({
    search: "",
    replace: "",
  });
  const [supportValue, setSupportValue] = useState(null);
  const [searchReplace, setSearchReplace] = useState({
    search: "",
    replace: "",
  });
  const [locationValue, setLocationValue] = useState("");
  const [destructiveConfirmationValue, setDestructiveConfirmationValue] =
    useState("");
  const [limitWarning, setLimitWarning] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 10,
    totalPages: 1,
  });
  const [modalState, setModalState] = useState({
    scheduleEdit: false,
    recurringEdit: false,
  });
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [pendingConfirmRun, setPendingConfirmRun] = useState(false);
  const debouncedInputValue = useDebouncedValue(draftInputValue, {
    delay: 600,
  });
  const debouncedSearch = useDebouncedValue(draftSearchReplace.search, {
    delay: 600,
  });
  const debouncedReplace = useDebouncedValue(draftSearchReplace.replace, {
    delay: 600,
  });

  useEffect(() => {
    setInputValue(debouncedInputValue);
  }, [debouncedInputValue]);

  useEffect(() => {
    setSearchReplace({
      search: debouncedSearch,
      replace: debouncedReplace,
    });
  }, [debouncedReplace, debouncedSearch]);

  useEffect(() => {
    setPagination((current) => ({ ...current, page: 1 }));
  }, [
    selectedField?.value,
    editTypeValue,
    inputValue,
    searchReplace.search,
    searchReplace.replace,
    locationValue,
    rounding,
    supportValue,
  ]);

  useEffect(() => {
    if (!selectedField) return;

    setEditTypeValue(null);
    setRounding("NONE");
    setDraftInputValue(null);
    setInputValue(null);
    setSupportValue(null);
    setDraftSearchReplace({ search: "", replace: "" });
    setSearchReplace({ search: "", replace: "" });
    setLocationValue("");
    setDestructiveConfirmationValue("");
    setPagination((current) => ({ ...current, page: 1 }));
  }, [selectedField]);

  const handleFieldChange = useCallback(
    (nextField) => {
      setSelectedField(resolveFieldSelection(nextField));
      setEditTypeValue(null);
      setRounding("NONE");
      setDraftInputValue(null);
      setInputValue(null);
      setSupportValue(null);
      setDraftSearchReplace({ search: "", replace: "" });
      setSearchReplace({ search: "", replace: "" });
      setLocationValue("");
      setDestructiveConfirmationValue("");
      setLimitWarning(null);
      setPagination((current) => ({ ...current, page: 1 }));
    },
    [],
  );

  const editType = useMemo(
    () => resolveEditTypeSelection(selectedField, editTypeValue),
    [editTypeValue, selectedField],
  );

  const handleEditTypeChange = useCallback((nextEditTypeValue) => {
      const nextEditType = resolveEditTypeSelection(selectedField, nextEditTypeValue);
      if (!nextEditType) {
        setEditTypeValue(null);
        return;
      }
      setEditTypeValue(nextEditTypeValue);
      setRounding("NONE");
      setDraftInputValue(null);
      setInputValue(null);
      setSupportValue(null);
      setDraftSearchReplace({ search: "", replace: "" });
      setSearchReplace({ search: "", replace: "" });
      setLocationValue("");
      setDestructiveConfirmationValue("");
      setLimitWarning(null);
      setPagination((current) => ({ ...current, page: 1 }));
    }, [selectedField]);

  const isPercentage = editType?.valueKind === ValueKind.PERCENTAGE;
  const isFixedValue =
    selectedField?.type === FieldType.NUMERIC &&
    editType?.operationKind === OperationKind.SET &&
    editType?.valueKind === ValueKind.FIXED_AMOUNT;
  const numericKind = getNumericKind(selectedField?.value, isPercentage);
  const maxPercentage = Number(editType?.maxPercentage ?? editType?.max ?? 100);

  const submitValidationRules = useMemo(
    () =>
      getValueValidationRules(isPercentage, isFixedValue, {
        numericKind,
        maxPercentage,
      }),
    [isPercentage, isFixedValue, maxPercentage, numericKind],
  );

  const submitError = useFieldValidation(
    draftInputValue,
    submitValidationRules,
  );

  const shouldHideEditTypeSelector =
    selectedField?.value === "status" || selectedField?.actions?.length <= 1;

    const effectiveFilters = useMemo(() => {
  const baseFilters = filters.filter((f) => f.field !== "search");

  if (!search?.trim()) {
    return baseFilters;
  }

  return [
    ...baseFilters,
    {
      field: "search",
      operator: "contains",
      value: search.trim(),
    },
  ];
}, [filters, search]);

  const validOps = selectedField?.actions?.map((action) => action.value) || [];
  const fieldConfirmationPhrase =
    selectedField?.confirmationPhrase || DEFAULT_CONFIRMATION_PHRASE;
  const requiresFieldConfirmation =
    selectedField?.requiresConfirmation === true ||
    selectedField?.riskLevel === "HIGH" ||
    selectedField?.riskLevel === "DESTRUCTIVE";
  const requiresDestructiveConfirmation =
    editType?.inputType === InputType.NONE &&
    editType?.requiresConfirmation === true;
  const hasFieldConfirmation =
    !requiresFieldConfirmation ||
    destructiveConfirmationValue === fieldConfirmationPhrase;
  const hasDestructiveConfirmation =
    !requiresDestructiveConfirmation ||
    destructiveConfirmationValue === DEFAULT_CONFIRMATION_PHRASE;
  const hasRequiredConfirmation =
    hasFieldConfirmation && hasDestructiveConfirmation;
  const previewQueryEnabled =
    Boolean(selectedField?.value) &&
    Boolean(editType?.value) &&
    validOps.includes(editType?.value) &&
    hasRequiredConfirmation &&
    !(
      editType?.inputType === InputType.SEARCH_REPLACE &&
      !searchReplace.search &&
      !searchReplace.replace
    );

  const previewQueryPayload = usePreviewQueryInput({
    selectedFieldValue: selectedField?.value,
    editTypeValue,
    inputValue,
    searchReplace,
    locationValue,
    effectiveFilters,
    supportValue,
    rounding,
  });
  const currentPreviewSignature = useMemo(
    () => createEditPreviewPayloadHash(previewQueryPayload),
    [previewQueryPayload],
  );

  const previewQuery = useEditPreviewQuery({
    enabled: previewQueryEnabled,
    language: i18n.language,
    page: pagination.page,
    limit: pagination.limit,
    queryKeyHash: currentPreviewSignature,
    payload: previewQueryPayload,
  });

  useEffect(() => {
    if (previewQuery.error) {
      showError(toSafeErrorMessage(t, previewQuery.error, "common.errors.generic"));
    }
  }, [previewQuery.error, showError, t]);

  const previewData = previewQuery.data || null;
  const products = useMemo(
    () => (Array.isArray(previewData?.rows) ? previewData.rows : EMPTY_PREVIEW_ROWS),
    [previewData?.rows],
  );
  const isVariant = previewData?.isVariant === true;
  const loading = previewQuery.isLoading || previewQuery.isFetching;
  const previewTotal = previewData?.pagination?.total || 0;
  const previewFingerprint = previewData?.previewFingerprint || null;
  const previewSignature = previewData?.previewSignature || null;
  const requiresBroadConfirmation = previewData?.requiresConfirmation === true;
  const previewRegistryVersion = previewData?.previewFingerprint
    ? {
        fieldRegistryVersion:
          previewData.previewFingerprint.fieldRegistryVersion || null,
        operatorRegistryVersion:
          previewData.previewFingerprint.operatorRegistryVersion || null,
      }
    : null;

  useEffect(() => {
    if (!previewData?.pagination) return;
    setPagination((current) => {
      const nextPage = Number(previewData.pagination.page || current.page || 1);
      const nextLimit = Number(previewData.pagination.limit || current.limit || 10);
      if (nextPage === current.page && nextLimit === current.limit) {
        return current;
      }
      return { ...current, page: nextPage, limit: nextLimit };
    });
  }, [previewData?.pagination]);

  const canRunEdit = useMemo(() => {
    if (!editType || !selectedField) return false;

    switch (editType.inputType) {
      case InputType.SEARCH_REPLACE:
        return Boolean(searchReplace?.search?.trim());
      case InputType.CHOICE_LIST:
      case InputType.API_AUTOCOMPLETE:
      case InputType.LOCATION_SELECT:
        return Boolean(draftInputValue);
      case InputType.SINGLE:
      case InputType.NONE:
        return true;
      default:
        return Boolean(draftInputValue?.toString().trim());
    }
  }, [editType, draftInputValue, searchReplace?.search, selectedField]);
  const hasFreshPreview = Boolean(
    previewFingerprint?.previewId &&
      previewSignature &&
      previewSignature === currentPreviewSignature,
  );
  const hasPreviewRegistryMismatch = Boolean(
    previewRegistryVersion &&
      filterRegistryVersions &&
      (String(previewRegistryVersion.fieldRegistryVersion || "") !==
        String(filterRegistryVersions.fieldRegistryVersion || "") ||
        String(previewRegistryVersion.operatorRegistryVersion || "") !==
          String(filterRegistryVersions.operatorRegistryVersion || "")),
  );
  const requiresLocationSelection = editType?.inputType === InputType.LOCATION_SELECT;
  const hasRequiredLocation = !requiresLocationSelection || Boolean(locationValue);

  const executeBulkEdit = useCallback(
    async (confirmBroadTarget) => {
      const json = await protectedApiPost(
        `/api/products/update?lang=${i18n.language}`,
        {
        editedField: selectedField.value,
        editedType: editType.value,
        value: inputValue,
        searchKey: searchReplace.search,
        replaceText: searchReplace.replace,
        location: locationValue,
        rounding,
        filterParams: effectiveFilters,
        previewId: previewFingerprint?.previewId || null,
        previewFilterHash: previewFingerprint?.filterHash || null,
        previewMirrorBatchId: previewFingerprint?.mirrorBatchId || null,
        previewFieldRegistryVersion: previewRegistryVersion?.fieldRegistryVersion || null,
        previewOperatorRegistryVersion: previewRegistryVersion?.operatorRegistryVersion || null,
        previewSignature,
        confirmBroadTarget,
        supportValue,
        },
        { idempotent: true },
      );
      showSuccess(
        t("bulkEditStartedToast", { defaultValue: "Bulk edit started" }),
      );
      navigate(`/editDetails/${json.id || json.operationId}`);
    },
    [
      searchReplace.replace,
      searchReplace.search,
      inputValue,
      editType?.value,
      effectiveFilters,
      i18n.language,
      locationValue,
      rounding,
      navigate,
      previewFingerprint?.filterHash,
      previewFingerprint?.mirrorBatchId,
      previewFingerprint?.previewId,
      previewSignature,
      previewRegistryVersion?.fieldRegistryVersion,
      previewRegistryVersion?.operatorRegistryVersion,
      selectedField?.value,
      supportValue,
      t,
    ],
  );

  const handleRunEdit = async () => {
    if (isSyncInProgress || submitting || isFilterRegistryDegraded) {
      return;
    }

    if (submitError) {
      showError(submitError);
      return;
    }

    if (
      editType?.inputType === InputType.SEARCH_REPLACE &&
      !draftSearchReplace.search?.trim()
    ) {
      showError(t("bulkEditSearchReplaceSearchRequired"))
      return;
    }

    if (!hasRequiredLocation) {
      showError(
        t("bulkEditLocationRequiredError", {
          defaultValue: "Select a location before running this inventory update.",
        }),
      );
      return;
    }

    if (!hasRequiredConfirmation) {
      showError(
        t("errors.confirmationMismatch", {
          phrase: fieldConfirmationPhrase,
          defaultValue: "You must type {{phrase}} exactly.",
        }),
      );
      return;
    }

    if (!editType || !canRunEdit || !hasFreshPreview) return;
    if (hasPreviewRegistryMismatch) {
      showError(
        t("bulkEditPreviewRegistryChangedError", {
          defaultValue: "Filter registry changed. Refresh preview before executing.",
        }),
      );
      return;
    }

    setSubmitting(true);
    setLimitWarning(null);

    try {
      if (requiresBroadConfirmation) {
        setConfirmModalOpen(true);
        setSubmitting(false);
        return;
      }
      await executeBulkEdit(false);
    } catch (err) {
      const safeMessage = toSafeErrorMessage(
        t,
        err,
        "common.errors.generic",
      );
      if (err?.status === 400 && safeMessage.toLowerCase().includes("plan")) {
        setLimitWarning(safeMessage);
        showError(safeMessage, { duration: 6000 });
        return;
      }
      showError(safeMessage);
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmAndRun = useCallback(async () => {
    if (confirmText.trim().toUpperCase() !== "CONFIRM") return;
    setPendingConfirmRun(true);
    try {
      await executeBulkEdit(true);
      setConfirmModalOpen(false);
      setConfirmText("");
    } catch (err) {
      showError(
        toSafeErrorMessage(t, err, "common.errors.generic"),
      );
    } finally {
      setPendingConfirmRun(false);
      setSubmitting(false);
    }
  }, [confirmText, executeBulkEdit]);

  const handleHideScheduleModal = useCallback(() => {
    setModalState((current) => ({ ...current, scheduleEdit: false }));
  }, []);

  const handleHideRecurringModal = useCallback(() => {
    setModalState((current) => ({ ...current, recurringEdit: false }));
  }, []);

const summaryText = useMemo(() => {
  if (loading) {
    return t("loadingProductsPreview");
  }

  if (previewTotal > 0) {
    return `${previewTotal} ${t("productsReadyToEdit")}`;
  }

  return t("noProductsMatch");
}, [previewTotal, loading, t]);

  return (
    <Page
      fullWidth
      title={t("ConfigureModifications")}
      backAction={{
        content: t("back", { defaultValue: "Back" }),
        icon: ChevronLeftIcon,
        onAction: () => navigate("/products"),
      }}
      primaryAction={{
        content: submitting ? t("Running") : t("RunEdit"),
        onAction: handleRunEdit,
        loading: submitting,
        disabled:
          isSyncInProgress ||
          submitting ||
          Boolean(submitError) ||
          isFilterRegistryDegraded ||
          !canRunEdit ||
          !hasFreshPreview ||
          hasPreviewRegistryMismatch ||
          !hasRequiredLocation ||
          !hasRequiredConfirmation,
      }}
      secondaryActions={[
        {
          content: t("ScheduleEdit"),
          onAction: () => setModalState((current) => ({ ...current, scheduleEdit: true })),
          disabled:
            isSyncInProgress ||
            isFilterRegistryDegraded ||
            !canRunEdit ||
            !hasFreshPreview ||
            hasPreviewRegistryMismatch ||
            !hasRequiredLocation ||
            !hasRequiredConfirmation,
        },
        {
          content: t("RecurringEdit"),
          onAction: () => setModalState((current) => ({ ...current, recurringEdit: true })),
          disabled:
            isSyncInProgress ||
            isFilterRegistryDegraded ||
            !canRunEdit ||
            !hasRequiredLocation ||
            !hasRequiredConfirmation,
        },
      ]}
    >
      <Layout>
        {isSyncInProgress && (
          <Layout.Section>
            <Banner
              tone={POLARIS_TONE_INFO}
              title={t("syncInProgressTitle", { defaultValue: "Sync in progress" })}
            >
              <p>
                {t("bulkEditSyncBlockingMessage",)}
              </p>
            </Banner>
          </Layout.Section>
        )}

        {isFilterRegistryDegraded && (
          <Layout.Section>
            <Banner
              tone={POLARIS_TONE_CRITICAL}
              title={t("filterRegistryLoadErrorTitle", {
                defaultValue: "Filter definitions could not be loaded",
              })}
            >
              <p>
                {t("filterRegistryBulkEditBlockedMessage", {
                  reason: filterRegistryFallbackReason,
                  defaultValue:
                    "Refresh the page before previewing or running a bulk edit.",
                })}
              </p>
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          {limitWarning && (
            <Box paddingBlockEnd={PADDING_BLOCK_END_300}>
              <Banner
                tone={POLARIS_TONE_WARNING}
                title={t("planLimitReachedTitle", { defaultValue: "Plan limit reached" })}
                onDismiss={() => setLimitWarning(null)}
                action={{
                  content: t("upgradePlanButton", { defaultValue: "Upgrade plan" }),
                  onAction: () => navigate("/pricing"),
                }}
              >
                <p>{limitWarning}</p>
              </Banner>
            </Box>
          )}

          <Card>
            <Box padding={PADDING_500}>
              <BlockStack gap={GAP_400}>
                <BlockStack gap={GAP_100}>
                  <Text as={TEXT_AS_H2} variant={TEXT_HEADING_MD}>
                    {t("bulkEditSetupTitle",)}
                  </Text>

                  <Text
                    as={TEXT_AS_P}
                    variant={TEXT_BODY_SM}
                    tone={POLARIS_TONE_SUBDUED}
                  >
                    {t("bulkEditSetupText",)}
                  </Text>
                </BlockStack>

                <FormLayout>
                  <FormLayout.Group condensed>
                      <FieldSelector
                        selectedField={selectedField}
                        onFieldChange={handleFieldChange}
                      />

                    {!shouldHideEditTypeSelector && (
                      <EditTypeSelector
                        selectedFieldValue={selectedField?.value}
                        editType={editTypeValue}
                        onEditTypeChange={handleEditTypeChange}
                      />
                    )}
                  </FormLayout.Group>

                  <ValueInput
                    selectedField={selectedField}
                    editType={editType}
                    value={draftInputValue}
                    onChange={setDraftInputValue}
                    searchReplace={draftSearchReplace}
                    onSearchReplaceChange={setDraftSearchReplace}
                    locationValue={locationValue}
                    onLocationChange={setLocationValue}
                    setSupportValue={setSupportValue}
                    confirmationValue={destructiveConfirmationValue}
                    onConfirmationChange={setDestructiveConfirmationValue}
                  />

                  {requiresFieldConfirmation && !requiresDestructiveConfirmation && (
                    <BlockStack gap={GAP_200}>
                      <Banner
                        tone={
                          selectedField?.riskLevel === "DESTRUCTIVE"
                            ? POLARIS_TONE_CRITICAL
                            : POLARIS_TONE_WARNING
                        }
                        title={t("products:fieldConfirmationRequiredTitle", {
                          defaultValue: "Confirm high-risk field edit",
                        })}
                      >
                        <p>
                          {t("products:fieldConfirmationRequiredMessage", {
                            field: selectedField?.label || selectedField?.value,
                            phrase: fieldConfirmationPhrase,
                            defaultValue:
                              "This field can affect storefront identity or product availability. Type {{phrase}} before previewing or running edits to {{field}}.",
                          })}
                        </p>
                      </Banner>
                      <TextField
                        label={t("typeConfirm", {
                          defaultValue: "Type CONFIRM to continue",
                        })}
                        value={destructiveConfirmationValue}
                        onChange={setDestructiveConfirmationValue}
                        error={
                          destructiveConfirmationValue &&
                          destructiveConfirmationValue !== fieldConfirmationPhrase
                            ? t("errors.confirmationMismatch", {
                                phrase: fieldConfirmationPhrase,
                                defaultValue: "You must type {{phrase}} exactly.",
                              })
                            : undefined
                        }
                        autoComplete={AUTOCOMPLETE_OFF}
                      />
                    </BlockStack>
                  )}
                </FormLayout>
              </BlockStack>
            </Box>
          </Card>
        </Layout.Section>

        <Layout.Section variant={LAYOUT_ONE_THIRD}>
          <Card>
            <Box padding={PADDING_500}>
              <BlockStack gap={GAP_300}>
                <Text as={TEXT_AS_H3} variant={TEXT_HEADING_MD}>
                  {t("bulkEditPreviewSummaryTitle",)}
                </Text>
                <InlineStack
                  gap={GAP_200}
                  blockAlign={INLINE_BLOCK_ALIGN_CENTER}
                >
                  <Badge
                    tone={
                      previewTotal > 0
                        ? POLARIS_TONE_INFO
                        : POLARIS_TONE_ATTENTION
                    }
                  >
  {previewTotal || 0}
</Badge>
                  <Text
                    as={TEXT_AS_SPAN}
                    variant={TEXT_BODY_SM}
                    tone={POLARIS_TONE_SUBDUED}
                  >
                    {t("bulkEditMatchingProductsLabel",)}
                  </Text>
                </InlineStack>
                <Text
                  as={TEXT_AS_P}
                  variant={TEXT_BODY_SM}
                  tone={POLARIS_TONE_SUBDUED}
                >
                  {summaryText}
                </Text>
                <MirrorFreshnessBadge isSyncInProgress={isSyncInProgress} />
                {!hasFreshPreview && (
                  <Banner
                    tone={POLARIS_TONE_WARNING}
                    title={t("bulkEditPreviewStaleTitle", { defaultValue: "Preview is stale" })}
                  >
                    <p>
                      {t("bulkEditPreviewStaleMessage", {
                        defaultValue: "Run preview again before executing this edit.",
                      })}
                    </p>
                  </Banner>
                )}
                {hasPreviewRegistryMismatch && (
                  <Banner
                    tone={POLARIS_TONE_CRITICAL}
                    title={t("bulkEditPreviewInvalidatedTitle", {
                      defaultValue: "Preview invalidated by filter registry change",
                    })}
                  >
                    <p>
                      {t("bulkEditPreviewInvalidatedMessage", {
                        defaultValue:
                          "Fields/operators changed on the server. Refresh preview before executing.",
                      })}
                    </p>
                  </Banner>
                )}
                {requiresLocationSelection && !hasRequiredLocation && (
                  <Banner
                    tone={POLARIS_TONE_CRITICAL}
                    title={t("bulkEditLocationRequiredTitle", {
                      defaultValue: "Location required",
                    })}
                  >
                    <p>
                      {t("bulkEditLocationRequiredMessage", {
                        defaultValue:
                          "Select a location for inventory updates before preview/execute.",
                      })}
                    </p>
                  </Banner>
                )}
                {requiresFieldConfirmation && !hasFieldConfirmation && (
                  <Banner
                    tone={
                      selectedField?.riskLevel === "DESTRUCTIVE"
                        ? POLARIS_TONE_CRITICAL
                        : POLARIS_TONE_WARNING
                    }
                    title={t("products:fieldConfirmationBlockedTitle", {
                      defaultValue: "Confirmation required",
                    })}
                  >
                    <p>
                      {t("products:fieldConfirmationBlockedMessage", {
                        phrase: fieldConfirmationPhrase,
                        defaultValue:
                          "Type {{phrase}} in the edit form before previewing, scheduling, or running this field edit.",
                      })}
                    </p>
                  </Banner>
                )}
                <Text
                  as={TEXT_AS_P}
                  variant={TEXT_BODY_SM}
                  tone={POLARIS_TONE_SUBDUED}
                >
                  {t("bulkEditPreviewSummaryText",)}
                </Text>
              </BlockStack>
            </Box>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <PreviewTable
            loading={loading}
            products={products}
            pagination={pagination}
            isVariant={isVariant}
            onPageChange={(page) => setPagination((current) => ({ ...current, page }))}
            field={selectedField.value}
          />
        </Layout.Section>
      </Layout>

      {modalState.scheduleEdit && (
        <ScheduleEdit
          show
          onHide={handleHideScheduleModal}
          count={previewTotal}
          editedField={selectedField.value}
          previewFingerprint={previewFingerprint}
          previewSignature={previewSignature}
          hasFreshPreview={hasFreshPreview}
          hasPreviewRegistryMismatch={hasPreviewRegistryMismatch}
        />
      )}

      {modalState.recurringEdit && (
        <RecurringEditModal
          show
          onHide={handleHideRecurringModal}
          count={previewTotal}
          editedField={selectedField.value}
          editedBy={editType?.value}
          value={inputValue}
          searchKey={searchReplace.search}
          replaceText={searchReplace.replace}
          location={locationValue}
          rounding={rounding}
          filters={effectiveFilters}
          supportValue={supportValue}
        />
      )}
      <Modal
        open={confirmModalOpen}
        title={t("bulkEditConfirmBroadTargetTitle", {
          defaultValue: "Confirm broad target edit",
        })}
        onClose={() => {
          if (pendingConfirmRun) return;
          setConfirmModalOpen(false);
          setConfirmText("");
          setSubmitting(false);
        }}
        primaryAction={{
          content: t("bulkEditConfirmAndRun", { defaultValue: "Confirm and run" }),
          onAction: handleConfirmAndRun,
          loading: pendingConfirmRun,
          disabled: confirmText.trim().toUpperCase() !== "CONFIRM",
        }}
        secondaryActions={[
          {
            content: t("cancel", { defaultValue: "Cancel" }),
            onAction: () => {
              setConfirmModalOpen(false);
              setConfirmText("");
              setSubmitting(false);
            },
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap={GAP_300}>
            <Text as={TEXT_AS_P} variant={TEXT_BODY_MD}>
              {t("bulkEditConfirmBroadTargetMessage", {
                count: previewTotal,
                defaultValue:
                  "This edit targets {{count}} items. Type CONFIRM to proceed.",
              })}
            </Text>
            <TextField
              autoComplete={AUTOCOMPLETE_OFF}
              label={t("bulkEditTypeConfirmLabel", { defaultValue: "Type CONFIRM" })}
              value={confirmText}
              onChange={setConfirmText}
            />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
