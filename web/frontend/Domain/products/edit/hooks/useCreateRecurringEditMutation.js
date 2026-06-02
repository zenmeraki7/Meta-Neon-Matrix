import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "../../../../hooks/useApiClient";
import { toSafeErrorMessage } from "../../../../utils/frontendError";

export const RECURRING_EDIT_QUERY_KEYS = Object.freeze({
  list: ["recurring-edits"],
  history: ["recurring-edit-history"],
  status: ["recurring-edit-status"],
  productHistory: ["product-edit-history"],
  scheduledEdits: ["scheduled-edits"],
});

export function mapCreateRecurringEditError(t, error) {
  const detail =
    error?.details ||
    error?.response?.data ||
    error?.data ||
    null;
  const code = detail?.code || error?.code || null;
  const message = toSafeErrorMessage(t, error, "common.errors.generic");

  return {
    code,
    message,
    isUpgradeRequired:
      code === "UPGRADE_REQUIRED" ||
      (typeof message === "string" && message.toLowerCase().includes("pro")),
  };
}

export function useCreateRecurringEditMutation() {
  const api = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ payload, idempotencyKey }) => {
      return api.post("/api/products/create-recurring-edit", payload, {
        idempotent: true,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
    },
    retry: false,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: RECURRING_EDIT_QUERY_KEYS.list,
        }),
        queryClient.invalidateQueries({
          queryKey: RECURRING_EDIT_QUERY_KEYS.history,
        }),
        queryClient.invalidateQueries({
          queryKey: RECURRING_EDIT_QUERY_KEYS.status,
        }),
        queryClient.invalidateQueries({
          queryKey: RECURRING_EDIT_QUERY_KEYS.productHistory,
        }),
        queryClient.invalidateQueries({
          queryKey: RECURRING_EDIT_QUERY_KEYS.scheduledEdits,
        }),
      ]);
    },
  });
}
