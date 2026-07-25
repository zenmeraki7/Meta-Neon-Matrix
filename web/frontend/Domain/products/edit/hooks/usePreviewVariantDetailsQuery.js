import { useQuery } from "@tanstack/react-query";
import { protectedApiGet } from "../../../../api/protectedApiClient";

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function usePreviewVariantDetailsQuery({
  previewId,
  productId,
  page = 1,
  limit = 50,
  enabled = false,
}) {
  return useQuery({
    queryKey: [
      "edit-preview-variant-details",
      previewId || null,
      productId || null,
      page,
      limit,
    ],
    enabled: enabled && Boolean(previewId) && Boolean(productId),
    queryFn: async ({ signal }) => {
      const data = await protectedApiGet(
        `/api/products/edit-preview/${encodeURIComponent(previewId)}/products/${encodeURIComponent(productId)}/variants?page=${page}&limit=${limit}`,
        { signal },
      );
      const payload = data?.data || data || {};
      const rows = Array.isArray(payload.rows) ? payload.rows : [];
      return {
        rows,
        page: safeNumber(payload.page, page),
        limit: safeNumber(payload.limit, limit),
        total: safeNumber(payload.total, rows.length),
        totalPages: safeNumber(
          payload.totalPages,
          Math.max(1, Math.ceil(rows.length / Math.max(limit, 1))),
        ),
      };
    },
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    placeholderData: (previous) => previous,
  });
}
