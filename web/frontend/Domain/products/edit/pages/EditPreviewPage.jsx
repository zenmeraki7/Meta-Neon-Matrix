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

import { getFieldDefinition, InputType } from "../constants";
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
  useEditPreviewQuery,
  usePreviewQueryInput,
} from "../hooks/useEditPreviewQuery";

function normalizeSignatureValue(value) {
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeSignatureValue(entry)).join(",");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return entries
      .map(([key, entryValue]) => `${key}:${normalizeSignatureValue(entryValue)}`)
      .join("|");
  }
  return String(value);
}

function lightweightStableHash(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export default function EditPreviewPage() {
  const filters = useSelector(selectFilters);
  const search = useSelector(selectSearch);
  const navigate = useNavigate();
  const { i18n, t } = useTranslation();
  const { isSyncInProgress } = useProductSyncStatus();
  const { showSuccess, showError } = useAppToast();
  const { versions: filterRegistryVersions } = useFilterRegistry();

  const [selectedField, setSelectedField] = useState(getFieldDefinition("price"));
  const [editType, setEditType] = useState(null);
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
  const debouncedInputValue = useDebouncedValue(draftInputValue, 600);
  const debouncedSearchReplace = useDebouncedValue(draftSearchReplace, 600);

  useEffect(() => {
    setInputValue(debouncedInputValue);
  }, [debouncedInputValue]);

  useEffect(() => {
    setSearchReplace(debouncedSearchReplace);
  }, [debouncedSearchReplace]);

  useEffect(() => {
    setPagination((current) => ({ ...current, page: 1 }));
  }, [
    selectedField?.value,
    editType?.value,
    inputValue,
    searchReplace.search,
    searchReplace.replace,
    locationValue,
    supportValue,
  ]);

  useEffect(() => {
    if (!selectedField) return;

    setEditType(null);
    setDraftInputValue(null);
    setInputValue(null);
    setSupportValue(null);
    setDraftSearchReplace({ search: "", replace: "" });
    setSearchReplace({ search: "", replace: "" });
    setLocationValue("");
    setPagination((current) => ({ ...current, page: 1 }));
  }, [selectedField]);

  const handleFieldChange = useCallback(
    (nextField) => {
      setSelectedField(nextField);
      setEditType(null);
      setDraftInputValue(null);
      setInputValue(null);
      setSupportValue(null);
      setDraftSearchReplace({ search: "", replace: "" });
      setSearchReplace({ search: "", replace: "" });
      setLocationValue("");
      setLimitWarning(null);
      setPagination((current) => ({ ...current, page: 1 }));
    },
    [],
  );

  const isPercentage = editType?.value?.toLowerCase().includes("percent");
  const isFixedValue =
    selectedField?.value === "price" &&
    editType?.value?.toLowerCase().includes("set") &&
    !isPercentage;

  const submitError = useFieldValidation(
    draftInputValue,
    getValueValidationRules(isPercentage, isFixedValue),
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

  const currentPreviewSignature = useMemo(() => {
      const filterSegment = effectiveFilters
        .map((filter) =>
          [
            normalizeSignatureValue(filter?.field),
            normalizeSignatureValue(filter?.operator),
            normalizeSignatureValue(filter?.value),
          ].join("~"),
        )
        .sort()
        .join("^");

      const payload = [
        normalizeSignatureValue(selectedField?.value || null),
        normalizeSignatureValue(editType?.value || null),
        normalizeSignatureValue(inputValue),
        normalizeSignatureValue(searchReplace.search),
        normalizeSignatureValue(searchReplace.replace),
        normalizeSignatureValue(locationValue || null),
        filterSegment,
        normalizeSignatureValue(supportValue),
        normalizeSignatureValue(pagination.page),
        normalizeSignatureValue(pagination.limit),
      ].join("||");

      return `sig_${lightweightStableHash(payload)}`;
    }, [
    selectedField?.value,
    editType?.value,
    inputValue,
    searchReplace.search,
    searchReplace.replace,
    locationValue,
    effectiveFilters,
    supportValue,
    pagination.page,
    pagination.limit,
  ]);

  const validOps = selectedField?.actions?.map((action) => action.value) || [];
  const previewQueryEnabled =
    Boolean(selectedField?.value) &&
    Boolean(editType?.value) &&
    validOps.includes(editType?.value) &&
    !(
      editType?.inputType === InputType.SEARCH_REPLACE &&
      !searchReplace.search &&
      !searchReplace.replace
    );

  const previewQueryPayload = usePreviewQueryInput({
    selectedField,
    editType,
    inputValue,
    searchReplace,
    locationValue,
    effectiveFilters,
    supportValue,
  });

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
  const products = previewData?.rows || [];
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
  }, [editType, draftInputValue, draftSearchReplace?.search, selectedField]);
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
    if (isSyncInProgress || submitting) {
      return;
    }

    if (submitError) {
      showError(submitError);
      return;
    }

    if (editType?.inputType === InputType.SEARCH_REPLACE && !draftSearchReplace.search) {
      showError(t("bulkEditSearchReplaceSearchRequired",))
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
          !canRunEdit ||
          !hasFreshPreview ||
          hasPreviewRegistryMismatch ||
          !hasRequiredLocation,
      }}
      secondaryActions={[
        {
          content: t("ScheduleEdit"),
          onAction: () => setModalState((current) => ({ ...current, scheduleEdit: true })),
          disabled: isSyncInProgress,
        },
        {
          content: t("RecurringEdit"),
          onAction: () => setModalState((current) => ({ ...current, recurringEdit: true })),
          disabled: isSyncInProgress,
        },
      ]}
    >
      <Layout>
        {isSyncInProgress && (
          <Layout.Section>
            <Banner
              tone="info"
              title={t("syncInProgressTitle", { defaultValue: "Sync in progress" })}
            >
              <p>
                {t("bulkEditSyncBlockingMessage",)}
              </p>
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          {limitWarning && (
            <Box paddingBlockEnd="300">
              <Banner
                tone="warning"
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
            <Box padding="500">
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    {t("bulkEditSetupTitle",)}
                  </Text>

                  <Text as="p" variant="bodySm" tone="subdued">
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
                        selectedField={selectedField}
                        editType={editType}
                        onEditTypeChange={setEditType}
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
                  />
                </FormLayout>
              </BlockStack>
            </Box>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <Box padding="500">
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  {t("bulkEditPreviewSummaryTitle",)}
                </Text>
                <InlineStack gap="200" blockAlign="center">
                  <Badge tone={previewTotal > 0 ? "info" : "attention"}>
  {previewTotal || 0}
</Badge>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {t("bulkEditMatchingProductsLabel",)}
                  </Text>
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  {summaryText}
                </Text>
                <MirrorFreshnessBadge isSyncInProgress={isSyncInProgress} />
                {!hasFreshPreview && (
                  <Banner
                    tone="warning"
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
                    tone="critical"
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
                    tone="critical"
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
                <Text as="p" variant="bodySm" tone="subdued">
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
          onHide={() => setModalState((current) => ({ ...current, scheduleEdit: false }))}
          count={previewTotal}
          editedField={selectedField.value}
          editedBy={editType?.value}
          value={inputValue}
          searchKey={searchReplace.search}
          replaceText={searchReplace.replace}
          location={locationValue}
          filters={effectiveFilters}
          supportValue={supportValue}
        />
      )}

      {modalState.recurringEdit && (
        <RecurringEditModal
          show
          onHide={() => setModalState((current) => ({ ...current, recurringEdit: false }))}
          count={previewTotal}
          editedField={selectedField.value}
          editedBy={editType?.value}
          value={inputValue}
          searchKey={searchReplace.search}
          replaceText={searchReplace.replace}
          location={locationValue}
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
          <BlockStack gap="300">
            <Text as="p" variant="bodyMd">
              {t("bulkEditConfirmBroadTargetMessage", {
                count: previewTotal,
                defaultValue:
                  "This edit targets {{count}} items. Type CONFIRM to proceed.",
              })}
            </Text>
            <TextField
              autoComplete="off"
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
