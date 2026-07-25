import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApiClient } from "../../../../hooks/useApiClient";
import { buildFilterAstFromLegacyFilters } from "../../list/utils/filterAst.js";

function safePositiveInteger(value, fallback = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function safeNonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function safeString(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim();
  return normalized || fallback;
}

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

export function createEditPreviewPayloadHash(payload) {
  const signaturePayload = [
    normalizeSignatureValue(payload?.field),
    normalizeSignatureValue(payload?.operation || payload?.editType),
    normalizeSignatureValue(payload?.editValue),
    normalizeSignatureValue(payload?.searchKey),
    normalizeSignatureValue(payload?.replaceText),
    normalizeSignatureValue(payload?.locationId),
    normalizeSignatureValue(payload?.rounding),
    normalizeSignatureValue(payload?.filterAst),
    normalizeSignatureValue(payload?.filterFingerprint),
    normalizeSignatureValue(payload?.filterVersion),
    normalizeSignatureValue(payload?.supportValue),
  ].join("||");

  return `sig_${lightweightStableHash(signaturePayload)}`;
}

export function createEditPreviewRequestKey(input) {
  return [
    normalizeSignatureValue(input?.field),
    normalizeSignatureValue(input?.operation || input?.editType),
    normalizeSignatureValue(input?.editValue ?? input?.value),
    normalizeSignatureValue(input?.rounding || "NONE"),
    normalizeSignatureValue(input?.locationId || input?.location || ""),
    normalizeSignatureValue(input?.filterFingerprint),
    normalizeSignatureValue(input?.filterVersion),
    normalizeSignatureValue(input?.searchKey),
    normalizeSignatureValue(input?.replaceText),
    normalizeSignatureValue(input?.supportValue),
  ].join("|");
}

function createFilterFingerprint(filterAst) {
  return `filter_${lightweightStableHash(normalizeSignatureValue(filterAst))}`;
}

function normalizeSupportValue(value) {
  if (value === undefined || value === null || value === "") return null;

  if (Array.isArray(value)) {
    return value.map(normalizeSupportValue);
  }

  if (typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = normalizeSupportValue(value[key]);
        return acc;
      }, {});
  }

  return value;
}

const VARIANT_LEVEL_PREVIEW_FIELDS = new Set([
  "barcode",
  "sku",
  "price",
  "compareAtPrice",
  "taxable",
  "inventoryPolicy",
  "inventory",
  "cost",
  "weight",
]);

const CANONICAL_OPERATION_BY_LEGACY_VALUE = Object.freeze({
  "Set to fixed value": "SET_FIXED",
  "Changed by fixed amount": "INCREASE_FIXED",
  "Increase by percent": "INCREASE_PERCENT",
  "Decrease by percent": "DECREASE_PERCENT",
  "Set to percentage of compare-at-price": "PERCENT_OF_COMPARE_AT_PRICE",
});

export function toCanonicalEditOperation(editTypeValue) {
  const value = safeString(editTypeValue, "");
  return CANONICAL_OPERATION_BY_LEGACY_VALUE[value] || value;
}

function buildEditPreviewRequestBody(payload, page, limit) {
  const body = {
    field: payload.field,
    operation: payload.operation,
    value: payload.editValue,
    locationId: payload.locationId,
    rounding: payload.rounding,
    filterAst: payload.filterAst,
    filterFingerprint: payload.filterFingerprint,
    filterVersion: payload.filterVersion,
    page,
    limit,
  };

  if (payload.searchKey) body.searchKey = payload.searchKey;
  if (payload.replaceText) body.replaceText = payload.replaceText;
  if (payload.supportValue !== null && payload.supportValue !== undefined) {
    body.supportValue = payload.supportValue;
  }

  return body;
}

function normalizePreviewResponse(rawData, fallbackPage, fallbackLimit, requestKey) {
  const data = rawData?.data || rawData || {};
  if (!Array.isArray(data?.rows) && !Array.isArray(data?.preview)) {
    throw new Error("Invalid edit preview response: missing rows.");
  }

  const rows = Array.isArray(data?.rows)
    ? data.rows
    : Array.isArray(data?.preview)
      ? data.preview
      : [];

  const page = safePositiveInteger(data?.page ?? data?.pagination?.page, fallbackPage);
  const limit = safePositiveInteger(data?.limit ?? data?.pagination?.limit, fallbackLimit);
  const total = safeNonNegativeInteger(
    data?.total ?? data?.pagination?.total,
    rows.length,
  );
  const totalPages = safePositiveInteger(
    data?.totalPages ?? data?.pagination?.totalPages,
    Math.max(1, Math.ceil(total / Math.max(limit, 1))),
  );

  const previewFingerprint = data?.previewFingerprint || {};
  const registryVersion = previewFingerprint?.registryVersion || {};
  const previewId = safeString(
    data?.previewId || previewFingerprint?.previewId,
    "",
  ) || null;
  const targetSnapshotId = safeString(data?.targetSnapshotId, "") || null;
  const normalizedFilterHash = safeString(previewFingerprint?.normalizedFilterHash, "") || null;

  return {
    rows,
    isVariant: data?.isVariant === true,
    previewSignature: safeString(data?.previewSignature, "") || null,
    requestKey,
    previewFingerprint: {
      previewId,
      normalizedFilterHash,
      mirrorBatchId: safeString(previewFingerprint?.mirrorBatchId, "") || null,
      targetCount: safeNonNegativeInteger(previewFingerprint?.targetCount, total),
      fieldRegistryVersion:
        safeString(
          previewFingerprint?.fieldRegistryVersion ||
            registryVersion?.fieldRegistryVersion,
          "",
        ) || null,
      operatorRegistryVersion:
        safeString(
          previewFingerprint?.operatorRegistryVersion ||
            registryVersion?.operatorRegistryVersion,
          "",
        ) || null,
    },
    requiresConfirmation: data?.requiresConfirmation === true,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      previewId,
      targetSnapshotId,
      resultVersion: previewId || targetSnapshotId || "default",
    },
  };
}

export function useEditPreviewQuery({
  enabled,
  language,
  page,
  limit,
  queryKeyHash,
  payload,
}) {
  const api = useApiClient();
  const safeLanguage = safeString(language, "en");
  const safePage = safePositiveInteger(page, null);
  const safeLimit = safePositiveInteger(limit, null);
  const payloadHash = createEditPreviewPayloadHash(payload);
  const requestKey = createEditPreviewRequestKey(payload);
  const safeQueryKeyHash = safeString(queryKeyHash, "");
  const hasCanonicalQueryKeyHash = safeQueryKeyHash === payloadHash;
  const canPreview =
    Boolean(enabled) &&
    Boolean(payload?.field) &&
    Boolean(payload?.operation || payload?.editType) &&
    Boolean(payload?.filterAst) &&
    Boolean(payload?.filterFingerprint) &&
    Boolean(payload?.filterVersion) &&
    Boolean(payloadHash) &&
    Boolean(requestKey) &&
    hasCanonicalQueryKeyHash &&
    safePage !== null &&
    safeLimit !== null;

  return useQuery({
    queryKey: [
      "edit-preview",
      {
        language: safeLanguage,
        page: safePage,
        limit: safeLimit,
        payloadHash,
      },
    ],
    enabled: canPreview,
    queryFn: async ({ signal }) => {
      const result = await api.post(
        `/api/products/edit-preview?lang=${encodeURIComponent(safeLanguage)}`,
        buildEditPreviewRequestBody(payload, safePage, safeLimit),
        { signal },
      );
      return normalizePreviewResponse(result, safePage, safeLimit, requestKey);
    },
    staleTime: 10_000,
    gcTime: 5 * 60 * 1000,
    placeholderData: (previous) => {
      if (previous?.requestKey === requestKey) {
        return previous;
      }

      return undefined;
    },
    refetchOnWindowFocus: false,
  });
}

export function usePreviewQueryInput({
  selectedFieldValue,
  editTypeValue,
  inputValue,
  searchReplace,
  locationValue,
  effectiveFilters,
  supportValue,
  rounding = "NONE",
}) {
  return useMemo(
    () => {
      const targetGranularity = VARIANT_LEVEL_PREVIEW_FIELDS.has(
        safeString(selectedFieldValue, ""),
      )
        ? "PRODUCT_WITH_MATCHING_VARIANTS"
        : "PRODUCT";
      const filterAst = buildFilterAstFromLegacyFilters({
        rawFilterInput: Array.isArray(effectiveFilters) ? effectiveFilters : [],
        targetGranularity,
        source: "MANUAL_PREVIEW",
      });

      return {
        field: safeString(selectedFieldValue, ""),
        editType: safeString(editTypeValue, ""),
        operation: toCanonicalEditOperation(editTypeValue),
        editValue: inputValue,
        searchKey: safeString(searchReplace?.search, ""),
        replaceText: safeString(searchReplace?.replace, ""),
        locationId: safeString(locationValue, ""),
        rounding: safeString(rounding, "NONE"),
        filterAst,
        filterFingerprint: createFilterFingerprint(filterAst),
        filterVersion: safeString(filterAst?.version, ""),
        supportValue: normalizeSupportValue(supportValue),
      };
    },
    [
      editTypeValue,
      effectiveFilters,
      inputValue,
      locationValue,
      rounding,
      searchReplace?.replace,
      searchReplace?.search,
      selectedFieldValue,
      supportValue,
    ],
  );
}
