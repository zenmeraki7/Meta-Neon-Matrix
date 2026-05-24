import React, { useState, useEffect, useCallback, useMemo } from "react";
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
import { toast } from "react-hot-toast";
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
import useDebounce from "../hooks/useDebounce";
import {
  selectFilters,
  selectSearch,
} from "../../../../store/slices/productSlice";
import useProductSyncStatus from "../../../../hooks/useProductSyncStatus";
import { buildFilterAstFromLegacyFilters } from "../../list/utils/filterAst";
import { useApiClient } from "../../../../hooks/useApiClient";
import { toSafeErrorMessage } from "../../../../utils/frontendError";

export default function EditPreviewPage() {
  const filters = useSelector(selectFilters);
  const search = useSelector(selectSearch);
  const navigate = useNavigate();
  const { i18n, t } = useTranslation();
  const { isSyncInProgress } = useProductSyncStatus();
  const api = useApiClient();

  const [selectedField, setSelectedField] = useState(getFieldDefinition("price"));
  const [editType, setEditType] = useState(null);
  const [inputValue, setInputValue] = useState("");
  const [supportValue, setSupportValue] = useState("");
  const [searchReplace, setSearchReplace] = useState({
    search: "",
    replace: "",
  });
  const [locationValue, setLocationValue] = useState("");
  const [limitWarning, setLimitWarning] = useState(null);
  const [products, setProducts] = useState([]);
  const [isVariant, setIsVariant] = useState(false);
  const [loading, setLoading] = useState(false);
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
  const [previewTotal, setPreviewTotal] = useState(0);
  const [previewFingerprint, setPreviewFingerprint] = useState(null);
  const [requiresBroadConfirmation, setRequiresBroadConfirmation] = useState(false);
  const [previewSignature, setPreviewSignature] = useState(null);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [pendingConfirmRun, setPendingConfirmRun] = useState(false);
  const debouncedValue = useDebounce(inputValue, 600);
  const debouncedSearchReplace = useDebounce(searchReplace, 600);

  useEffect(() => {
    setPreviewFingerprint(null);
    setPreviewSignature(null);
  }, [
    selectedField?.value,
    editType?.value,
    debouncedValue,
    debouncedSearchReplace.search,
    debouncedSearchReplace.replace,
    locationValue,
    supportValue,
  ]);

  useEffect(() => {
    if (!selectedField) return;

    const actions = selectedField.actions;
    if (actions?.length) {
      setEditType(actions[0]);
      setInputValue("");
      setSupportValue("");
      setSearchReplace({ search: "", replace: "" });
      setLocationValue("");
      setPagination((current) => ({ ...current, page: 1 }));
    }
  }, [selectedField]);

  const isPercentage = editType?.value?.toLowerCase().includes("percent");
  const isFixedValue =
    selectedField?.value === "price" &&
    editType?.value?.toLowerCase().includes("set") &&
    !isPercentage;

  const submitError = useFieldValidation(
    inputValue,
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

  const buildCurrentPreviewSignature = useCallback(
    () =>
      JSON.stringify({
        field: selectedField?.value || null,
        editType: editType?.value || null,
        editValue: debouncedValue,
        searchKey: debouncedSearchReplace.search,
        replaceText: debouncedSearchReplace.replace,
        locationId: locationValue || null,
        filterParams: effectiveFilters,
        supportValue,
        page: pagination.page,
        limit: pagination.limit,
      }),
    [
      selectedField?.value,
      editType?.value,
      debouncedValue,
      debouncedSearchReplace.search,
      debouncedSearchReplace.replace,
      locationValue,
      effectiveFilters,
      supportValue,
      pagination.page,
      pagination.limit,
    ],
  );

  const fetchPreview = useCallback(async () => {
    if (!editType || !selectedField) return;
    const validOps = selectedField.actions?.map((a) => a.value) || [];
    if (!validOps.includes(editType.value)) return;

    if (
    editType.inputType === InputType.SEARCH_REPLACE &&
    !debouncedSearchReplace.search &&
    !debouncedSearchReplace.replace
  ) {
    return;
  }

    setLoading(true);

    try {
      const signature = buildCurrentPreviewSignature();
      const json = await api.post(`/api/products/edit-preview?lang=${i18n.language}`, {
          field: selectedField.value,
          editType: editType.value,
          editValue: debouncedValue,
          searchKey: debouncedSearchReplace.search,
          replaceText: debouncedSearchReplace.replace,
          locationId: locationValue,
          filterParams: effectiveFilters,
          filterAst: buildFilterAstFromLegacyFilters({
            filterParams: effectiveFilters,
            targetGranularity: "PRODUCT",
            source: "MANUAL_PREVIEW",
          }),
          page: pagination.page,
          limit: pagination.limit,
          supportValue,
        });

      setProducts(json.data.preview);
      setPagination(json.data.pagination);
      setIsVariant(json.data.isVariant);
      setPreviewTotal(json.data.pagination?.total || 0);
      setPreviewFingerprint(json.data.previewFingerprint || null);
      setPreviewSignature(signature);
      setRequiresBroadConfirmation(json.data.requiresConfirmation === true);
    } catch (err) {
      toast.error(toSafeErrorMessage(err, "Failed to load preview"));
    } finally {
      setLoading(false);
    }
  }, [
    editType,
    selectedField,
    debouncedValue,
    debouncedSearchReplace,
    locationValue,
    effectiveFilters,
    pagination.page,
    pagination.limit,
    supportValue,
    i18n.language,
    api,
    buildCurrentPreviewSignature,
  ]);

  useEffect(() => {
    fetchPreview();
  }, [fetchPreview]);

  const canRunEdit = useMemo(() => {
    if (!editType || !selectedField) return false;

    switch (editType.inputType) {
      case InputType.SEARCH_REPLACE:
        return Boolean(searchReplace?.search?.trim());
      case InputType.CHOICE_LIST:
      case InputType.API_AUTOCOMPLETE:
      case InputType.LOCATION_SELECT:
        return Boolean(inputValue);
      case InputType.SINGLE:
      case InputType.NONE:
        return true;
      default:
        return Boolean(inputValue?.toString().trim());
    }
  }, [editType, inputValue, searchReplace?.search, selectedField]);
  const hasFreshPreview = Boolean(
    previewFingerprint?.previewId &&
      previewSignature &&
      previewSignature === buildCurrentPreviewSignature(),
  );
  const requiresLocationSelection = editType?.inputType === InputType.LOCATION_SELECT;
  const hasRequiredLocation = !requiresLocationSelection || Boolean(locationValue);

  const executeBulkEdit = useCallback(
    async (confirmBroadTarget) => {
      const json = await api.post(`/api/products/update?lang=${i18n.language}`, {
        editedField: selectedField.value,
        editedType: editType.value,
        value: debouncedValue,
        searchKey: debouncedSearchReplace.search,
        replaceText: debouncedSearchReplace.replace,
        location: locationValue,
        filterParams: effectiveFilters,
        filterAst: buildFilterAstFromLegacyFilters({
          filterParams: effectiveFilters,
          targetGranularity: "PRODUCT",
          source: "MANUAL_EXECUTE",
        }),
        previewId: previewFingerprint?.previewId || null,
        previewFilterHash: previewFingerprint?.filterHash || null,
        previewMirrorBatchId: previewFingerprint?.mirrorBatchId || null,
        confirmBroadTarget,
        supportValue,
      });
      toast.success("Bulk edit started");
      navigate(`/editDetails/${json.id || json.operationId}`);
    },
    [
      api,
      debouncedSearchReplace.replace,
      debouncedSearchReplace.search,
      debouncedValue,
      editType?.value,
      effectiveFilters,
      i18n.language,
      locationValue,
      navigate,
      previewFingerprint?.filterHash,
      previewFingerprint?.mirrorBatchId,
      previewFingerprint?.previewId,
      selectedField?.value,
      supportValue,
    ],
  );

  const handleRunEdit = async () => {
    if (isSyncInProgress || submitting) {
      return;
    }

    if (submitError) {
      toast.error(submitError);
      return;
    }

    if (editType?.inputType === InputType.SEARCH_REPLACE && !searchReplace.search) {
      toast.error(t("bulkEditSearchReplaceSearchRequired",))
      return;
    }

    if (!hasRequiredLocation) {
      toast.error("Select a location before running this inventory update.");
      return;
    }

    if (!editType || !canRunEdit || !hasFreshPreview) return;

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
      if (err?.status === 400 && err.message?.toLowerCase().includes("plan")) {
        setLimitWarning(err.message);
        toast.error(err.message, { duration: 6000 });
        return;
      }
      toast.error(toSafeErrorMessage(err, "Failed to update products"));
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
      toast.error(toSafeErrorMessage(err, "Failed to update products"));
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
        content: "Back",
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
            <Banner tone="info" title="Sync in progress">
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
                title="Plan limit reached"
                onDismiss={() => setLimitWarning(null)}
                action={{
                  content: "Upgrade plan",
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
                      onFieldChange={setSelectedField}
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
                    value={inputValue}
                    onChange={setInputValue}
                    searchReplace={searchReplace}
                    onSearchReplaceChange={setSearchReplace}
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
                {!hasFreshPreview && (
                  <Banner tone="warning" title="Preview is stale">
                    <p>Run preview again before executing this edit.</p>
                  </Banner>
                )}
                {requiresLocationSelection && !hasRequiredLocation && (
                  <Banner tone="critical" title="Location required">
                    <p>Select a location for inventory updates before preview/execute.</p>
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
          value={debouncedValue}
          searchKey={debouncedSearchReplace.search}
          replaceText={debouncedSearchReplace.replace}
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
          value={debouncedValue}
          searchKey={debouncedSearchReplace.search}
          replaceText={debouncedSearchReplace.replace}
          location={locationValue}
          filters={effectiveFilters}
          supportValue={supportValue}
        />
      )}
      <Modal
        open={confirmModalOpen}
        title="Confirm broad target edit"
        onClose={() => {
          if (pendingConfirmRun) return;
          setConfirmModalOpen(false);
          setConfirmText("");
          setSubmitting(false);
        }}
        primaryAction={{
          content: "Confirm and run",
          onAction: handleConfirmAndRun,
          loading: pendingConfirmRun,
          disabled: confirmText.trim().toUpperCase() !== "CONFIRM",
        }}
        secondaryActions={[
          {
            content: "Cancel",
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
              This edit targets {previewTotal} items. Type <strong>CONFIRM</strong> to proceed.
            </Text>
            <TextField
              autoComplete="off"
              label="Type CONFIRM"
              value={confirmText}
              onChange={setConfirmText}
            />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}


