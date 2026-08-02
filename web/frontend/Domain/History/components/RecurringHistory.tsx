import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import {
  protectedApiDelete,
  protectedApiGet,
  protectedApiPut,
} from "../../../api/protectedApiClient";
import { toSafeErrorMessage } from "../../../utils/frontendError";
import { useToast as useAppToast } from "../../../components/providers/ToastProvider";
import type { RecurringEditSummary } from "../../../../../shared/recurringEdit";

const CONFIRMATION_MODAL_ID =
  "recurring-history-confirmation-modal";

const RECURRING_STATUS = {
  ACTIVE: "ACTIVE",
  PAUSED: "PAUSED",
} as const;

type RecurringStatus =
  (typeof RECURRING_STATUS)[keyof typeof RECURRING_STATUS];

const MODAL_ACTION = {
  TOGGLE: "toggle",
  CANCEL: "cancel",
} as const;

type ModalAction =
  (typeof MODAL_ACTION)[keyof typeof MODAL_ACTION];

type BadgeTone =
  | "success"
  | "warning"
  | "critical"
  | "info"
  | "neutral";

function isActiveRecurringEdit(
  edit: RecurringEditSummary,
): boolean {
  return edit.statusKey === "ACTIVE";
}

interface RecurringListResponse {
  items?: unknown;
  data?: unknown;
  [key: string]: unknown;
}

interface ToggleRecurringEditRequest {
  status: RecurringStatus;
}

interface ToggleMutationVariables {
  id: string;
  nextStatus: RecurringStatus;
}

interface ModalState {
  open: boolean;
  type: ModalAction | null;
  targetId: string | null;
}

type ShopifyModalElement =
  HTMLElementTagNameMap["s-modal"];

const INITIAL_MODAL_STATE: Readonly<ModalState> =
  Object.freeze({
    open: false,
    type: null,
    targetId: null,
  });

function createInitialModalState(): ModalState {
  return {
    ...INITIAL_MODAL_STATE,
  };
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isRecurringEditSummary(
  value: unknown,
): value is RecurringEditSummary {
  return isRecord(value);
}

function getStatusTone(
  edit: RecurringEditSummary,
): BadgeTone {
  return isActiveRecurringEdit(edit)
    ? "success"
    : "warning";
}

function getRecurringItemId(
  edit: RecurringEditSummary,
): string | null {
  if (
    edit.id === undefined ||
    edit.id === null
  ) {
    return null;
  }

  const id = String(edit.id).trim();

  return id || null;
}

function normalizeRecurringListResponse(
  value: unknown,
): RecurringEditSummary[] {
  if (!isRecord(value)) {
    return [];
  }

  const response =
    value as RecurringListResponse;

  const items =
    response.items ??
    response.data ??
    [];

  if (!Array.isArray(items)) {
    return [];
  }

  return items.filter(
    isRecurringEditSummary,
  );
}

function normalizeDisplayText(
  value: unknown,
  fallback: string,
): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim();

  return normalized || fallback;
}

export default function RecurringHistory() {
  const { t } = useTranslation([
    "history",
    "common",
  ]);

  const { showSuccess, showError } =
    useAppToast();

  const queryClient = useQueryClient();

  const modalRef =
    useRef<ShopifyModalElement | null>(null);

  const [
    modalState,
    setModalState,
  ] = useState<ModalState>(
    createInitialModalState,
  );

  const recurringQuery = useQuery<
    RecurringEditSummary[],
    unknown
  >({
    queryKey: [
      "recurring-list-summary",
      50,
    ],
    queryFn: async ({
      signal,
    }): Promise<
      RecurringEditSummary[]
    > => {
      const result: unknown =
        await protectedApiGet(
          "/api/products/recurring/list-summary?limit=50",
          {
            signal,
          },
        );

      return normalizeRecurringListResponse(
        result,
      );
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const recurringEdits =
    recurringQuery.data ?? [];

  const selectedEdit = useMemo<
    RecurringEditSummary | null
  >(() => {
    if (!modalState.targetId) {
      return null;
    }

    return (
      recurringEdits.find(
        (edit) =>
          getRecurringItemId(edit) ===
          modalState.targetId,
      ) ?? null
    );
  }, [
    modalState.targetId,
    recurringEdits,
  ]);

  const closeModalState =
    useCallback((): void => {
      setModalState(
        createInitialModalState(),
      );
    }, []);

  const toggleMutation = useMutation<
    unknown,
    unknown,
    ToggleMutationVariables
  >({
    mutationFn: async ({
      id,
      nextStatus,
    }): Promise<unknown> => {
      const requestBody:
        ToggleRecurringEditRequest = {
          status: nextStatus,
        };

      return protectedApiPut(
        `/api/products/update-recurring-edit/${encodeURIComponent(
          id,
        )}/toggle`,
        requestBody,
        {
          idempotent: true,
        },
      );
    },
    retry: false,
    onSuccess: async (
      _data,
      variables,
    ): Promise<void> => {
      await queryClient.invalidateQueries({
        queryKey: [
          "recurring-list-summary",
        ],
      });

      showSuccess(
        variables.nextStatus ===
          RECURRING_STATUS.ACTIVE
          ? t("resumedSuccessfully")
          : t("pausedSuccessfully"),
      );
    },
    onError: (error: unknown): void => {
      showError(
        toSafeErrorMessage(
          t,
          error,
          "common.errors.generic",
        ),
      );
    },
    onSettled: (): void => {
      modalRef.current?.hideOverlay();
    },
  });

  const deleteMutation = useMutation<
    unknown,
    unknown,
    string
  >({
    mutationFn: async (
      id,
    ): Promise<unknown> =>
      protectedApiDelete(
        `/api/products/delete-recurring-edit/${encodeURIComponent(
          id,
        )}`,
        {
          idempotent: true,
        },
      ),
    retry: false,
    onSuccess: async (): Promise<void> => {
      await queryClient.invalidateQueries({
        queryKey: [
          "recurring-list-summary",
        ],
      });

      showSuccess(
        t("cancelledSuccessfully"),
      );
    },
    onError: (error: unknown): void => {
      showError(
        toSafeErrorMessage(
          t,
          error,
          "common.errors.generic",
        ),
      );
    },
    onSettled: (): void => {
      modalRef.current?.hideOverlay();
    },
  });

  const mutationPending =
    toggleMutation.isPending ||
    deleteMutation.isPending;

  const closeModal = useCallback((): void => {
    if (mutationPending) {
      return;
    }

    modalRef.current?.hideOverlay();
  }, [mutationPending]);

  const openModal = useCallback(
    (
      type: ModalAction,
      id: string,
    ): void => {
      const targetId = id.trim();

      if (!targetId) {
        return;
      }

      setModalState({
        open: true,
        type,
        targetId,
      });
    },
    [],
  );

  useEffect(() => {
    const modal = modalRef.current;

    if (!modal) {
      return;
    }

    if (modalState.open) {
      modal.showOverlay();
    } else {
      modal.hideOverlay();
    }
  }, [modalState.open]);

  const confirmAction =
    useCallback((): void => {
      const { type, targetId } =
        modalState;

      if (
        !targetId ||
        !type ||
        mutationPending
      ) {
        return;
      }

      if (type === MODAL_ACTION.CANCEL) {
        deleteMutation.mutate(
          targetId,
        );
        return;
      }

      if (
        type === MODAL_ACTION.TOGGLE &&
        selectedEdit
      ) {
        toggleMutation.mutate({
          id: targetId,
          nextStatus:
            isActiveRecurringEdit(
              selectedEdit,
            )
              ? RECURRING_STATUS.PAUSED
              : RECURRING_STATUS.ACTIVE,
        });
      }
    }, [
      deleteMutation,
      modalState,
      mutationPending,
      selectedEdit,
      toggleMutation,
    ]);

  const handleRetry =
    useCallback((): void => {
      void recurringQuery.refetch();
    }, [recurringQuery]);

  if (recurringQuery.isLoading) {
    return (
      <s-grid
        gap="base"
        justifyItems="center"
        paddingBlock="large"
      >
        <s-spinner
          accessibilityLabel={t(
            "loading",
          )}
          size="large"
        />

        <s-text color="subdued">
          {t("loadingRecurring")}
        </s-text>
      </s-grid>
    );
  }

  if (recurringQuery.isError) {
    const error =
      toSafeErrorMessage(
        t,
        recurringQuery.error,
        "common.errors.generic",
      );

    return (
      <s-banner
        heading={t(
          "errorLoadingRecurring",
        )}
        tone="critical"
      >
        <s-paragraph>
          {error}
        </s-paragraph>

        <s-button
          slot="primary-action"
          onClick={handleRetry}
        >
          {t("retry")}
        </s-button>
      </s-banner>
    );
  }

  if (recurringEdits.length === 0) {
    return (
      <s-section
        accessibilityLabel={t(
          "noRecurringEdits",
        )}
      >
        <s-grid
          gap="base"
          justifyItems="center"
          paddingBlock="large-400"
        >
          <s-stack
            gap="base"
            alignItems="center"
          >
            <s-icon
              type="calendar"
              size="large"
            />

            <s-heading>
              {t("noRecurringEdits")}
            </s-heading>

            <s-paragraph color="subdued">
              {t("noRecurringDesc")}
            </s-paragraph>

            <s-button
              variant="primary"
              href="/edit"
            >
              {t("scheduleNewEdit")}
            </s-button>
          </s-stack>
        </s-grid>
      </s-section>
    );
  }

  const unavailableLabel = t(
    "common:unavailable",
    {
      defaultValue: "—",
    },
  );

  const confirmationTitle =
    modalState.type ===
    MODAL_ACTION.CANCEL
      ? t("confirmCancelTitle")
      : t("confirmToggleTitle");

  return (
    <>
      <s-stack gap="base">
        {recurringEdits.map(
          (edit) => {
            const id =
              getRecurringItemId(edit);

            if (!id) {
              return null;
            }

            const active =
              isActiveRecurringEdit(
                edit,
              );

            const fieldLabel =
              normalizeDisplayText(
                edit.field,
                unavailableLabel,
              );

            const nextRunLabel =
              normalizeDisplayText(
                edit.nextRunAt,
                unavailableLabel,
              );

            const handleToggle =
              (): void => {
                openModal(
                  MODAL_ACTION.TOGGLE,
                  id,
                );
              };

            const handleCancel =
              (): void => {
                openModal(
                  MODAL_ACTION.CANCEL,
                  id,
                );
              };

            return (
              <s-section key={id}>
                <s-stack gap="base">
                  <s-grid
                    gridTemplateColumns="minmax(0, 1fr) auto"
                    gap="base"
                    alignItems="center"
                  >
                    <s-stack
                      direction="inline"
                      gap="small"
                      alignItems="center"
                    >
                      <s-icon type="calendar" />

                      <s-heading>
                        {fieldLabel}
                      </s-heading>
                    </s-stack>

                    <s-badge
                      tone={getStatusTone(
                        edit,
                      )}
                    >
                      {active
                        ? t("active")
                        : t("paused")}
                    </s-badge>
                  </s-grid>

                  <s-paragraph color="subdued">
                    {t("nextRun")}:{" "}
                    {nextRunLabel}
                  </s-paragraph>

                  <s-divider />

                  <s-button-group gap="small">
                    <s-button
                      variant="secondary"
                      tone={
                        active
                          ? "critical"
                          : undefined
                      }
                      disabled={
                        mutationPending
                      }
                      onClick={
                        handleToggle
                      }
                    >
                      {active
                        ? t("pause")
                        : t("resume")}
                    </s-button>

                    <s-button
                      variant="secondary"
                      tone="critical"
                      disabled={
                        mutationPending
                      }
                      onClick={
                        handleCancel
                      }
                    >
                      {t("cancel")}
                    </s-button>
                  </s-button-group>
                </s-stack>
              </s-section>
            );
          },
        )}
      </s-stack>

      <s-modal
        ref={modalRef}
        id={CONFIRMATION_MODAL_ID}
        heading={confirmationTitle}
        accessibilityLabel={
          confirmationTitle
        }
        onHide={closeModalState}
      >
        <s-paragraph>
          {modalState.type ===
          MODAL_ACTION.CANCEL
            ? t("confirmCancelText")
            : t("confirmToggleText")}
        </s-paragraph>

        <s-button
          slot="primary-action"
          variant="primary"
          tone={
            modalState.type ===
            MODAL_ACTION.CANCEL
              ? "critical"
              : undefined
          }
          loading={mutationPending}
          disabled={
            mutationPending ||
            !modalState.targetId ||
            !modalState.type
          }
          onClick={confirmAction}
        >
          {modalState.type ===
          MODAL_ACTION.CANCEL
            ? t("confirmCancel")
            : t("confirm")}
        </s-button>

        <s-button
          slot="secondary-actions"
          variant="secondary"
          disabled={mutationPending}
          onClick={closeModal}
        >
          {t("common:back", {
            defaultValue: "Back",
          })}
        </s-button>
      </s-modal>
    </>
  );
}
