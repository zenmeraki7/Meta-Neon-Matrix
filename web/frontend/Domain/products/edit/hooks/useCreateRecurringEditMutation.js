import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "../../../../hooks/useApiClient";
import { toSafeErrorMessage } from "../../../../utils/frontendError";

const UPGRADE_REQUIRED_CODES = new Set([
  "UPGRADE_REQUIRED",
  "PLAN_REQUIRED",
  "RECURRING_EDIT_PLAN_REQUIRED",
  "RECURRING_EDIT_PRO_PLAN_REQUIRED",
]);

export const RECURRING_EDIT_QUERY_KEYS = Object.freeze({
  all: ["recurring-edits"],

  lists: () => ["recurring-edits", "list"],
  list: (params = {}) => ["recurring-edits", "list", params],

  historyLists: () => ["recurring-edits", "history"],
  history: (params = {}) => ["recurring-edits", "history", params],

  status: (id) => ["recurring-edits", "status", id],

  scheduledLists: () => ["recurring-edits", "scheduled"],
  scheduled: (params = {}) => ["recurring-edits", "scheduled", params],

  productHistory: (params = {}) => ["product-edit-history", params],
});

export function mapCreateRecurringEditError(t, error) {
  const detail =
    error?.details ||
    error?.response?.data?.error ||
    error?.response?.data ||
    error?.data?.error ||
    error?.data ||
    error?.payload ||
    null;
  const code = detail?.code || error?.code || null;
  const serverMessage =
    detail?.message ||
    detail?.rootCause ||
    detail?.errors?.body ||
    error?.message ||
    "";

  return {
    code,
    message:
      serverMessage ||
      toSafeErrorMessage(t, error, "common.errors.generic"),
    isUpgradeRequired:
      UPGRADE_REQUIRED_CODES.has(code) ||
      detail?.upgradeRequired === true,
  };
}

export function useCreateRecurringEditMutation() {
  const api = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ payload, idempotencyKey }) => {
      if (!idempotencyKey) {
        throw new Error("Missing idempotency key for recurring edit creation.");
      }

      const response = await api.post("/api/recurring-edits", payload, {
        idempotent: true,
        idempotencyKey,
      });

      return response?.data ?? response;
    },
    retry: false,
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: RECURRING_EDIT_QUERY_KEYS.lists(),
      });

      queryClient.invalidateQueries({
        queryKey: RECURRING_EDIT_QUERY_KEYS.scheduledLists(),
      });

      queryClient.invalidateQueries({
        queryKey: RECURRING_EDIT_QUERY_KEYS.historyLists(),
      });
    },
  });
}
