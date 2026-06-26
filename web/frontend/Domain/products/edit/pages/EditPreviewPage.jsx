import React, { useState, useCallback, useMemo, useEffect } from "react";
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
  TextField,
  IndexTable,
  Pagination,
  SkeletonBodyText,
  EmptyState,
} from "@shopify/polaris";
import { ChevronLeftIcon } from "@shopify/polaris-icons";
import { useSelector } from "react-redux";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";

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
import { useApiClient } from "../../../../hooks/useApiClient";
import useProducts from "../../list/hooks/useProducts";
import ProductCell from "../../list/components/ProductCell";
import StatusBadge from "../../list/components/StatusBadge";
import { resolveProductTargetingContract } from "../../shared/productTargetingContract";
import {
  createEditPreviewPayloadHash,
  createEditPreviewRequestKey,
  toCanonicalEditOperation,
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

function getProductRowId(product) {
  return String(
    product?.__rowId ||
      product?.shopifyProductId ||
      product?.adminGraphqlApiId ||
      product?.gid ||
      product?.id ||
      ""
  ).trim();
}

function formatCellValue(value, fallback = "-") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function extractFieldErrors(error) {
  const errors = error?.payload?.errors || error?.details?.errors || null;
  if (!errors || typeof errors !== "object" || Array.isArray(errors)) return [];
  return Object.entries(errors)
    .map(([field, message]) => ({
      field,
      message: String(message || "").trim(),
    }))
    .filter((item) => item.message);
}

function getCurrentFieldValue(product, field) {
  switch (field) {
    case "title":
      return product?.title;
    case "description":
    case "descriptionHtml":
      return product?.description || product?.descriptionHtml;
    case "vendor":
      return product?.vendor;
    case "productType":
    case "product_type":
      return product?.productType;
    case "status":
      return product?.status;
    case "tags":
      return Array.isArray(product?.tags)
        ? product.tags.join(", ")
        : product?.tags;
    default:
      return product?.[field];
  }
}

function MatchingProductsTable({
  products = [],
  loading,
  pagination,
  onNext,
  onPrev,
  field,
  previewRows = [],
  variantsByProductId = {},
  variantsLoading = false,
  variantsError = null,
}) {
  const previewByProductId = useMemo(() => {
    const map = new Map();
    for (const row of previewRows) {
      const productId = String(row?.productId || row?.id || "").trim();
      if (productId) map.set(productId, row);
    }
    return map;
  }, [previewRows]);

  const safeProducts = Array.isArray(products) ? products : [];
  const isPriceField = field === "price";

  const priceRows = useMemo(() => {
    if (!isPriceField) return [];
    const rows = [];

    for (const product of safeProducts) {
      const productId = getProductRowId(product);
      const previewProduct = previewByProductId.get(productId);
      const previewVariants = Array.isArray(previewProduct?.variants)
        ? previewProduct.variants
        : [];
      const currentVariants = Array.isArray(variantsByProductId?.[productId])
        ? variantsByProductId[productId]
        : [];
      const sourceVariants = previewVariants.length
        ? previewVariants
        : currentVariants;

      if (!sourceVariants.length) {
        rows.push({
          key: productId || `product-${rows.length}`,
          product,
          variantTitle: "",
          currentValue: null,
          newValue: null,
        });
        continue;
      }

      for (const variant of sourceVariants) {
        const variantId = String(
          variant?.variantId || variant?.id || ""
        ).trim();
        rows.push({
          key: variantId || `${productId}:variant-${rows.length}`,
          product,
          variantTitle: variant?.title || "Default Title",
          currentValue:
            variant?.oldValue?.displayText ??
            variant?.oldValue ??
            variant?.price ??
            null,
          newValue: variant?.newValue?.displayText ?? variant?.newValue ?? null,
        });
      }
    }

    return rows;
  }, [isPriceField, previewByProductId, safeProducts, variantsByProductId]);

  if (loading) {
    return (
      <Card>
        <Box padding="400">
          <SkeletonBodyText lines={8} />
        </Box>
      </Card>
    );
  }

  if (!safeProducts.length) {
    return (
      <Card>
        <EmptyState heading="No products match the current filters">
          <p>Try changing or clearing filters to broaden the product set.</p>
        </EmptyState>
      </Card>
    );
  }

  if (isPriceField) {
    return (
      <Card padding="0">
        <Box padding="400" borderBlockEndWidth="1" borderColor="border">
          <BlockStack gap="100">
            <Text as="h2" variant="headingMd">
              Matching products
            </Text>
            {variantsError ? (
              <Banner tone="critical" title="Unable to load current prices." />
            ) : null}
          </BlockStack>
        </Box>
        {variantsLoading ? (
          <Box padding="400">
            <SkeletonBodyText lines={8} />
          </Box>
        ) : (
          <IndexTable
            resourceName={{ singular: "product", plural: "products" }}
            itemCount={priceRows.length}
            selectable={false}
            headings={[
              { title: "Product" },
              { title: "Current price" },
              { title: "New price" },
            ]}
          >
            {priceRows.map((row, index) => (
              <IndexTable.Row id={row.key} key={row.key} position={index}>
                <IndexTable.Cell>
                  <BlockStack gap="050">
                    <ProductCell
                      title={row.product?.title || ""}
                      handle={row.product?.handle || ""}
                      imageUrl={
                        row.product?.featuredImageUrl ||
                        row.product?.featuredMedia?.preview?.image?.url ||
                        ""
                      }
                    />
                    {row.variantTitle ? (
                      <Text as="p" variant="bodySm" tone="subdued">
                        {row.variantTitle}
                      </Text>
                    ) : null}
                  </BlockStack>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  {formatCellValue(row.currentValue)}
                </IndexTable.Cell>
                <IndexTable.Cell>
                  {formatCellValue(row.newValue)}
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        )}
        <Box padding="400" borderBlockStartWidth="1" borderColor="border">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="p" variant="bodySm" tone="subdued">
              Showing {pagination?.page || 1} of {pagination?.totalPages || 1}
            </Text>
            <Pagination
              hasPrevious={Boolean(pagination?.hasPrevPage)}
              onPrevious={onPrev}
              hasNext={Boolean(pagination?.hasNextPage)}
              onNext={onNext}
            />
          </InlineStack>
        </Box>
      </Card>
    );
  }

  return (
    <Card padding="0">
      <Box padding="400" borderBlockEndWidth="1" borderColor="border">
        <Text as="h2" variant="headingMd">
          Matching products
        </Text>
      </Box>
      <IndexTable
        resourceName={{ singular: "product", plural: "products" }}
        itemCount={safeProducts.length}
        selectable={false}
        headings={[
          { title: "Product" },
          { title: "Status" },
          { title: "Inventory" },
          { title: "Product type" },
          { title: "Vendor" },
          { title: "Current value" },
          { title: "Preview value" },
        ]}
      >
        {safeProducts.map((product, index) => {
          const rowId = getProductRowId(product);
          const previewRow = previewByProductId.get(rowId);
          return (
            <IndexTable.Row
              id={rowId || `product-${index}`}
              key={rowId || index}
              position={index}
            >
              <IndexTable.Cell>
                <ProductCell
                  title={product?.title || ""}
                  handle={product?.handle || ""}
                  imageUrl={
                    product?.featuredImageUrl ||
                    product?.featuredMedia?.preview?.image?.url ||
                    ""
                  }
                />
              </IndexTable.Cell>
              <IndexTable.Cell>
                <StatusBadge status={product?.status} />
              </IndexTable.Cell>
              <IndexTable.Cell>
                {formatCellValue(product?.totalInventory)}
              </IndexTable.Cell>
              <IndexTable.Cell>
                {formatCellValue(product?.productType)}
              </IndexTable.Cell>
              <IndexTable.Cell>
                {formatCellValue(product?.vendor)}
              </IndexTable.Cell>
              <IndexTable.Cell>
                {formatCellValue(
                  previewRow?.oldValue ?? getCurrentFieldValue(product, field)
                )}
              </IndexTable.Cell>
              <IndexTable.Cell>
                {formatCellValue(previewRow?.newValue)}
              </IndexTable.Cell>
            </IndexTable.Row>
          );
        })}
      </IndexTable>
      <Box padding="400" borderBlockStartWidth="1" borderColor="border">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="p" variant="bodySm" tone="subdued">
            Showing {pagination?.page || 1} of {pagination?.totalPages || 1}
          </Text>
          <Pagination
            hasPrevious={Boolean(pagination?.hasPrevPage)}
            onPrevious={onPrev}
            hasNext={Boolean(pagination?.hasNextPage)}
            onNext={onNext}
          />
        </InlineStack>
      </Box>
    </Card>
  );
}

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

function getDefaultEditTypeValue(field) {
  const actions = Array.isArray(field?.actions) ? field.actions : [];
  if (!actions.length) return null;
  const preferred = actions.find(
    (action) => action?.value === "Set to fixed value"
  );
  return (preferred || actions[0])?.value || null;
}

function getRunEditHistoryId(response) {
  const data =
    response?.data &&
    typeof response.data === "object" &&
    !Array.isArray(response.data)
      ? response.data
      : {};
  const candidate =
    response?.historyId ||
    response?.jobId ||
    response?.id ||
    response?.operationId ||
    data.historyId ||
    data.jobId ||
    data.id ||
    data.operationId;
  const historyId = String(candidate || "").trim();
  return historyId && historyId !== "undefined" && historyId !== "null"
    ? historyId
    : null;
}

export default function EditPreviewPage() {
  const filters = useSelector(selectFilters);
  const search = useSelector(selectSearch);
  const navigate = useNavigate();
  const location = useLocation();
  const api = useApiClient();
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

  const [selectedField, setSelectedField] = useState(
    getFieldDefinition("price")
  );
  const [editTypeValue, setEditTypeValue] = useState(() =>
    getDefaultEditTypeValue(getFieldDefinition("price"))
  );
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
  const [matchingCursor, setMatchingCursor] = useState(null);
  const [modalState, setModalState] = useState({
    scheduleEdit: false,
    recurringEdit: false,
  });
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

    setEditTypeValue(getDefaultEditTypeValue(selectedField));
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

  const handleFieldChange = useCallback((nextField) => {
    const resolvedField = resolveFieldSelection(nextField);
    setSelectedField(resolvedField);
    setEditTypeValue(getDefaultEditTypeValue(resolvedField));
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
  }, []);

  const editType = useMemo(
    () => resolveEditTypeSelection(selectedField, editTypeValue),
    [editTypeValue, selectedField]
  );

  const handleEditTypeChange = useCallback(
    (nextEditTypeValue) => {
      const nextEditType = resolveEditTypeSelection(
        selectedField,
        nextEditTypeValue
      );
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
    },
    [selectedField]
  );

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
    [isPercentage, isFixedValue, maxPercentage, numericKind]
  );

  const submitError = useFieldValidation(
    draftInputValue,
    submitValidationRules
  );

  const shouldHideEditTypeSelector =
    selectedField?.value === "status" || selectedField?.actions?.length <= 1;

  const productTargeting = useMemo(
    () =>
      resolveProductTargetingContract({
        navigationState: location.state,
        filters,
        searchQuery: search,
      }),
    [filters, location.state, search]
  );

  const effectiveFilters = productTargeting.filters;

  useEffect(() => {
    setMatchingCursor(null);
  }, [productTargeting.filterHash]);

  const matchingProductsQuery = useProducts({
    cursor: matchingCursor,
    filterParams: effectiveFilters,
    cursorFilterHash: productTargeting.filterHash,
    limit: 10,
  });
  const matchingProductIds = useMemo(
    () => matchingProductsQuery.products.map(getProductRowId).filter(Boolean),
    [matchingProductsQuery.products]
  );
  const variantsQuery = useQuery({
    queryKey: ["edit-matching-variants", matchingProductIds.join("|")],
    enabled: selectedField?.value === "price" && matchingProductIds.length > 0,
    queryFn: async ({ signal }) =>
      api.post(
        "/api/variants/query",
        {
          limit: 500,
          productIds: matchingProductIds,
        },
        { signal }
      ),
    staleTime: 10_000,
    retry: 1,
  });

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
  const inputValueText = String(inputValue ?? "").trim();
  const numericInputValue = Number(inputValueText);
  const requiresSingleValue = editType?.inputType === InputType.SINGLE;
  const hasValidSingleValue =
    !requiresSingleValue ||
    (inputValueText.length > 0 && Number.isFinite(numericInputValue));
  const previewQueryEnabled =
    Boolean(selectedField?.value) &&
    Boolean(editType?.value) &&
    validOps.includes(editType?.value) &&
    hasRequiredConfirmation &&
    hasValidSingleValue &&
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
    [previewQueryPayload]
  );
  const currentPreviewRequestKey = useMemo(
    () => createEditPreviewRequestKey(previewQueryPayload),
    [previewQueryPayload]
  );

  const previewQuery = useEditPreviewQuery({
    enabled: previewQueryEnabled,
    language: i18n.language,
    page: pagination.page,
    limit: pagination.limit,
    queryKeyHash: currentPreviewSignature,
    payload: previewQueryPayload,
  });
  const previewValidationErrors = useMemo(
    () => extractFieldErrors(previewQuery.error),
    [previewQuery.error]
  );

  useEffect(() => {
    if (previewQuery.error) {
      const fieldError = previewValidationErrors[0]?.message;
      showError(
        fieldError ||
          toSafeErrorMessage(t, previewQuery.error, "common.errors.generic")
      );
    }
  }, [previewQuery.error, previewValidationErrors, showError, t]);

  const previewData = previewQuery.data || null;
  const products = useMemo(
    () =>
      Array.isArray(previewData?.rows) ? previewData.rows : EMPTY_PREVIEW_ROWS,
    [previewData?.rows]
  );
  const isVariant = previewData?.isVariant === true;
  const loading = previewQuery.isLoading || previewQuery.isFetching;
  const previewTotal = previewData?.pagination?.total || 0;
  const previewFingerprint = previewData?.previewFingerprint || null;
  const previewSignature = previewData?.previewSignature || null;
  const previewRequestKey = previewData?.requestKey || null;
  const requiresBroadConfirmation = previewData?.requiresConfirmation === true;
  const [hasGeneratedPreview, setHasGeneratedPreview] = useState(false);
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
    if (previewData?.previewFingerprint?.previewId) {
      setHasGeneratedPreview(true);
    }
    setPagination((current) => {
      const nextPage = Number(previewData.pagination.page || current.page || 1);
      const nextLimit = Number(
        previewData.pagination.limit || current.limit || 10
      );
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
      previewFingerprint?.filterHash &&
      previewFingerprint?.mirrorBatchId &&
      previewRegistryVersion?.fieldRegistryVersion &&
      previewRegistryVersion?.operatorRegistryVersion &&
      previewRequestKey &&
      previewRequestKey === currentPreviewRequestKey
  );
  const shouldShowPreviewStale = hasGeneratedPreview && !hasFreshPreview;
  const matchingTotal = Number(matchingProductsQuery.totalCount || 0);
  const displayedMatchingTotal = hasGeneratedPreview
    ? previewTotal
    : matchingTotal;
  const hasBlockedPreviewRows = useMemo(
    () =>
      products.some((product) => {
        const productStatus = String(product?.status || "").toUpperCase();
        if (
          ["BLOCKED", "ERROR"].includes(productStatus) ||
          Boolean(product?.warning)
        ) {
          return true;
        }

        return (
          Array.isArray(product?.variants) &&
          product.variants.some(
            (variant) =>
              ["BLOCKED", "ERROR"].includes(
                String(variant?.status || "").toUpperCase()
              ) || Boolean(variant?.warning)
          )
        );
      }),
    [products]
  );
  const hasRunnablePreviewRows = useMemo(
    () =>
      products.some((product) => {
        if (String(product?.status || "").toUpperCase() === "READY") {
          return true;
        }

        return (
          Array.isArray(product?.variants) &&
          product.variants.some(
            (variant) => String(variant?.status || "").toUpperCase() === "READY"
          )
        );
      }),
    [products]
  );
  const hasPreviewRegistryMismatch = Boolean(
    previewRegistryVersion &&
      filterRegistryVersions &&
      (String(previewRegistryVersion.fieldRegistryVersion || "") !==
        String(filterRegistryVersions.fieldRegistryVersion || "") ||
        String(previewRegistryVersion.operatorRegistryVersion || "") !==
          String(filterRegistryVersions.operatorRegistryVersion || ""))
  );
  const requiresLocationSelection =
    editType?.inputType === InputType.LOCATION_SELECT;
  const hasRequiredLocation =
    !requiresLocationSelection || Boolean(locationValue);

  const executeBulkEdit = useCallback(
    async (confirmBroadTarget) => {
      const json = await api.post(
        `/api/products/update?lang=${i18n.language}`,
        {
          field: selectedField.value,
          operation: toCanonicalEditOperation(editType.value),
          value: inputValue,
          ...(searchReplace.search ? { searchKey: searchReplace.search } : {}),
          ...(searchReplace.replace
            ? { replaceText: searchReplace.replace }
            : {}),
          location: locationValue,
          rounding,
          filterParams: effectiveFilters,
          previewId: previewFingerprint?.previewId || null,
          previewFilterHash: previewFingerprint?.filterHash || null,
          previewMirrorBatchId: previewFingerprint?.mirrorBatchId || null,
          previewFieldRegistryVersion:
            previewRegistryVersion?.fieldRegistryVersion || null,
          previewOperatorRegistryVersion:
            previewRegistryVersion?.operatorRegistryVersion || null,
          previewSignature,
          confirmBroadTarget,
          ...(supportValue !== null && supportValue !== undefined
            ? { supportValue }
            : {}),
        },
        { idempotent: true }
      );
      showSuccess(
        t("bulkEditStartedToast", { defaultValue: "Bulk edit started" })
      );
      const historyId = getRunEditHistoryId(json);
      if (!historyId) {
        console.error(
          "[bulk-edit] missing history id in update response",
          json
        );
        showError(
          t("bulkEditMissingHistoryIdError", {
            defaultValue: "Edit started, but no history ID was returned.",
          })
        );
        return;
      }
      navigate(`/editDetails/${encodeURIComponent(historyId)}`);
    },
    [
      api,
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
      showError,
      supportValue,
      t,
    ]
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
      showError(t("bulkEditSearchReplaceSearchRequired"));
      return;
    }

    if (!hasRequiredLocation) {
      showError(
        t("bulkEditLocationRequiredError", {
          defaultValue:
            "Select a location before running this inventory update.",
        })
      );
      return;
    }

    if (!hasRequiredConfirmation) {
      showError(
        t("errors.confirmationMismatch", {
          phrase: fieldConfirmationPhrase,
          defaultValue: "You must type {{phrase}} exactly.",
        })
      );
      return;
    }

    if (
      !editType ||
      !canRunEdit ||
      !hasFreshPreview ||
      previewTotal < 1 ||
      !hasRunnablePreviewRows ||
      hasBlockedPreviewRows
    )
      return;
    if (hasPreviewRegistryMismatch) {
      showError(
        t("bulkEditPreviewRegistryChangedError", {
          defaultValue:
            "Filter registry changed. Refresh preview before executing.",
        })
      );
      return;
    }

    setSubmitting(true);
    setLimitWarning(null);

    try {
      await executeBulkEdit(requiresBroadConfirmation);
    } catch (err) {
      const safeMessage = toSafeErrorMessage(t, err, "common.errors.generic");
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

    if (displayedMatchingTotal > 0) {
      return hasGeneratedPreview
        ? `${displayedMatchingTotal} ${t("productsReadyToEdit")}`
        : `${displayedMatchingTotal} matching products`;
    }

    return t("noProductsMatch");
  }, [displayedMatchingTotal, hasGeneratedPreview, loading, t]);

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
          previewTotal < 1 ||
          !hasRunnablePreviewRows ||
          hasPreviewRegistryMismatch ||
          hasBlockedPreviewRows ||
          !hasRequiredLocation ||
          !hasRequiredConfirmation,
      }}
      secondaryActions={[
        {
          content: t("ScheduleEdit"),
          onAction: () =>
            setModalState((current) => ({ ...current, scheduleEdit: true })),
          disabled:
            isSyncInProgress ||
            isFilterRegistryDegraded ||
            !canRunEdit ||
            !hasFreshPreview ||
            previewTotal < 1 ||
            !hasRunnablePreviewRows ||
            hasPreviewRegistryMismatch ||
            hasBlockedPreviewRows ||
            !hasRequiredLocation ||
            !hasRequiredConfirmation,
        },
        {
          content: t("RecurringEdit"),
          onAction: () =>
            setModalState((current) => ({ ...current, recurringEdit: true })),
          disabled:
            isSyncInProgress ||
            isFilterRegistryDegraded ||
            !canRunEdit ||
            !hasFreshPreview ||
            previewTotal < 1 ||
            !hasRunnablePreviewRows ||
            hasPreviewRegistryMismatch ||
            hasBlockedPreviewRows ||
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
              title={t("syncInProgressTitle", {
                defaultValue: "Sync in progress",
              })}
            >
              <p>{t("bulkEditSyncBlockingMessage")}</p>
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
                title={t("planLimitReachedTitle", {
                  defaultValue: "Plan limit reached",
                })}
                onDismiss={() => setLimitWarning(null)}
                action={{
                  content: t("upgradePlanButton", {
                    defaultValue: "Upgrade plan",
                  }),
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
                    {t("bulkEditSetupTitle")}
                  </Text>

                  <Text
                    as={TEXT_AS_P}
                    variant={TEXT_BODY_SM}
                    tone={POLARIS_TONE_SUBDUED}
                  >
                    {t("bulkEditSetupText")}
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

                  {requiresFieldConfirmation &&
                    !requiresDestructiveConfirmation && (
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
                              field:
                                selectedField?.label || selectedField?.value,
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
                            destructiveConfirmationValue !==
                              fieldConfirmationPhrase
                              ? t("errors.confirmationMismatch", {
                                  phrase: fieldConfirmationPhrase,
                                  defaultValue:
                                    "You must type {{phrase}} exactly.",
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
                  {t("bulkEditPreviewSummaryTitle")}
                </Text>
                <InlineStack
                  gap={GAP_200}
                  blockAlign={INLINE_BLOCK_ALIGN_CENTER}
                >
                  <Badge
                    tone={
                      displayedMatchingTotal > 0
                        ? POLARIS_TONE_INFO
                        : POLARIS_TONE_ATTENTION
                    }
                  >
                    {displayedMatchingTotal || 0}
                  </Badge>
                  <Text
                    as={TEXT_AS_SPAN}
                    variant={TEXT_BODY_SM}
                    tone={POLARIS_TONE_SUBDUED}
                  >
                    {t("bulkEditMatchingProductsLabel")}
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
                {!hasGeneratedPreview && (
                  <Banner
                    tone={POLARIS_TONE_INFO}
                    title={t("bulkEditPreviewNotReadyTitle", {
                      defaultValue: "Preview not ready",
                    })}
                  >
                    <p>
                      {t("bulkEditPreviewNotReadyMessage", {
                        defaultValue:
                          "Choose an edit and wait for preview before running it.",
                      })}
                    </p>
                  </Banner>
                )}
                {hasGeneratedPreview && hasFreshPreview && (
                  <Banner
                    tone={POLARIS_TONE_INFO}
                    title={t("bulkEditPreviewReadyTitle", {
                      defaultValue: "Preview ready",
                    })}
                  >
                    <p>
                      {t("bulkEditPreviewReadyMessage", {
                        defaultValue:
                          "This preview matches the current edit and can be run.",
                      })}
                    </p>
                  </Banner>
                )}
                {shouldShowPreviewStale && (
                  <Banner
                    tone={POLARIS_TONE_WARNING}
                    title={t("bulkEditPreviewStaleTitle", {
                      defaultValue: "Preview is stale",
                    })}
                  >
                    <p>
                      {t("bulkEditPreviewStaleMessage", {
                        defaultValue:
                          "Run preview again before executing this edit.",
                      })}
                    </p>
                  </Banner>
                )}
                {previewValidationErrors.length > 0 && (
                  <Banner
                    tone={POLARIS_TONE_CRITICAL}
                    title={t("bulkEditPreviewValidationTitle", {
                      defaultValue: "Preview request needs attention",
                    })}
                  >
                    {previewValidationErrors.map((item) => (
                      <p key={`${item.field}:${item.message}`}>
                        {item.field}: {item.message}
                      </p>
                    ))}
                  </Banner>
                )}
                {hasPreviewRegistryMismatch && (
                  <Banner
                    tone={POLARIS_TONE_CRITICAL}
                    title={t("bulkEditPreviewInvalidatedTitle", {
                      defaultValue:
                        "Preview invalidated by filter registry change",
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
                  {t("bulkEditPreviewSummaryText")}
                </Text>
              </BlockStack>
            </Box>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <MatchingProductsTable
            loading={matchingProductsQuery.loading}
            products={matchingProductsQuery.products}
            pagination={matchingProductsQuery.pagination}
            onNext={() =>
              setMatchingCursor(
                matchingProductsQuery.pagination?.nextCursor || null
              )
            }
            onPrev={() =>
              setMatchingCursor(
                matchingProductsQuery.pagination?.prevCursor || null
              )
            }
            field={selectedField.value}
            previewRows={products}
            variantsByProductId={variantsQuery.data?.variantsByProductId || {}}
            variantsLoading={
              variantsQuery.isLoading || variantsQuery.isFetching
            }
            variantsError={variantsQuery.error}
          />
        </Layout.Section>

        {selectedField.value !== "price" ? (
          <Layout.Section>
            <PreviewTable
              loading={loading}
              products={products}
              pagination={pagination}
              isVariant={isVariant}
              onPageChange={(page) =>
                setPagination((current) => ({ ...current, page }))
              }
              field={selectedField.value}
            />
          </Layout.Section>
        ) : null}
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
          previewFingerprint={previewFingerprint}
          previewSignature={previewSignature}
          hasFreshPreview={hasFreshPreview}
          hasPreviewRegistryMismatch={hasPreviewRegistryMismatch}
          value={inputValue}
          searchKey={searchReplace.search}
          replaceText={searchReplace.replace}
          location={locationValue}
          rounding={rounding}
          filters={effectiveFilters}
          supportValue={supportValue}
        />
      )}
    </Page>
  );
}
