import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApiClient } from "../../../../hooks/useApiClient";

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeString(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim();
  return normalized || fallback;
}

function normalizePreviewResponse(rawData, fallbackPage, fallbackLimit) {
  const data = rawData?.data || rawData || {};
  const rows = Array.isArray(data?.rows)
    ? data.rows
    : Array.isArray(data?.preview)
      ? data.preview
      : [];

  const page = safeNumber(data?.page || data?.pagination?.page, fallbackPage);
  const limit = safeNumber(data?.limit || data?.pagination?.limit, fallbackLimit);
  const total = safeNumber(
    data?.total || data?.pagination?.total,
    rows.length,
  );
  const totalPages = safeNumber(
    data?.totalPages || data?.pagination?.totalPages,
    Math.max(1, Math.ceil(total / Math.max(limit, 1))),
  );

  const previewFingerprint = data?.previewFingerprint || {};
  const previewId = safeString(
    data?.previewId || previewFingerprint?.previewId,
    "",
  ) || null;
  const targetSnapshotId = safeString(
    data?.targetSnapshotId || previewFingerprint?.filterHash,
    "",
  ) || null;

  return {
    rows,
    isVariant: data?.isVariant === true,
    previewSignature: safeString(data?.previewSignature, "") || null,
    previewFingerprint: {
      previewId,
      filterHash: safeString(previewFingerprint?.filterHash, "") || null,
      mirrorBatchId: safeString(previewFingerprint?.mirrorBatchId, "") || null,
      fieldRegistryVersion:
        safeString(previewFingerprint?.fieldRegistryVersion, "") || null,
      operatorRegistryVersion:
        safeString(previewFingerprint?.operatorRegistryVersion, "") || null,
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

  return useQuery({
    queryKey: ["edit-preview", language || "en", queryKeyHash, page, limit],
    enabled,
    queryFn: async ({ signal }) => {
      const result = await api.post(
        `/api/products/edit-preview?lang=${language || "en"}`,
        {
          ...payload,
          page,
          limit,
        },
        { signal },
      );
      return normalizePreviewResponse(result, page, limit);
    },
    staleTime: 10_000,
    gcTime: 5 * 60 * 1000,
    placeholderData: (previous) => previous,
    refetchOnWindowFocus: false,
  });
}

export function usePreviewQueryInput({
  selectedField,
  editType,
  inputValue,
  searchReplace,
  locationValue,
  effectiveFilters,
  supportValue,
}) {
  return useMemo(
    () => ({
      field: selectedField?.value,
      editType: editType?.value,
      editValue: inputValue,
      searchKey: searchReplace?.search || "",
      replaceText: searchReplace?.replace || "",
      locationId: locationValue || "",
      filterParams: effectiveFilters,
      supportValue,
    }),
    [
      editType?.value,
      effectiveFilters,
      inputValue,
      locationValue,
      searchReplace?.replace,
      searchReplace?.search,
      selectedField?.value,
      supportValue,
    ],
  );
}
