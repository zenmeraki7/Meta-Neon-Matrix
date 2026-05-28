import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  Spinner,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Banner,
  Button,
  Divider,
  EmptyState,
  Modal,
} from "@shopify/polaris";
import { CalendarIcon } from "@shopify/polaris-icons";
import { useTranslation } from "react-i18next";
import { protectedApiDelete, protectedApiGet, protectedApiPut } from "../../../api/protectedApiClient";
import { toSafeErrorMessage } from "../../../utils/frontendError";
import { useToast as useAppToast } from "../../../components/providers/ToastProvider";

export default function RecurringHistory() {
  const { t } = useTranslation();
  const { showSuccess, showError } = useAppToast();
  const queryClient = useQueryClient();

  const [modalState, setModalState] = useState({
    open: false,
    type: null,
    targetId: null,
  });
  const recurringQuery = useQuery({
    queryKey: ["recurring-list-summary", 50],
    queryFn: async ({ signal }) => {
      const data = await protectedApiGet("/api/products/recurring/list-summary?limit=50", { signal });
      return data?.items || data?.data || [];
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, nextStatus }) =>
      protectedApiPut(
        `/api/products/update-recurring-edit/${id}/toggle`,
        { status: nextStatus },
        { idempotent: true },
      ),
    retry: false,
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["recurring-list-summary"] });
      showSuccess(
        variables.nextStatus === "ACTIVE"
          ? t("resumedSuccessfully")
          : t("pausedSuccessfully"),
      );
    },
    onError: (err) => {
      showError(toSafeErrorMessage(t, err, "common.errors.generic"));
    },
    onSettled: () => {
      setModalState({ open: false, type: null, targetId: null });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id) =>
      protectedApiDelete(`/api/products/delete-recurring-edit/${id}`, {
        idempotent: true,
      }),
    retry: false,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["recurring-list-summary"] });
      showSuccess(t("cancelledSuccessfully"));
    },
    onError: (err) => {
      showError(toSafeErrorMessage(t, err, "common.errors.generic"));
    },
    onSettled: () => {
      setModalState({ open: false, type: null, targetId: null });
    },
  });

  // === Modal Confirmation Handlers ===
  const openModal = (type, id) => setModalState({ open: true, type, targetId: id });
  const closeModal = () => setModalState({ open: false, type: null, targetId: null });

  const confirmAction = () => {
    const { type, targetId } = modalState;
    if (!targetId || !type) return;
    if (type === "cancel") {
      deleteMutation.mutate(targetId);
    }
    else if (type === "toggle") {
      const recurringEdits = recurringQuery.data || [];
      const target = recurringEdits.find((r) => r.id === targetId);
      if (target) {
        const isActive = String(target.statusKey || "").toUpperCase() === "ACTIVE";
        toggleMutation.mutate({
          id: targetId,
          nextStatus: isActive ? "PAUSED" : "ACTIVE",
        });
      }
    }
  };

  // === Render States ===
  if (recurringQuery.isLoading) {
    return (
      <BlockStack align="center" gap="400" padding="400">
        <Spinner accessibilityLabel={t("loading")} size="large" />
        <Text tone="subdued">{t("loadingRecurring")}</Text>
      </BlockStack>
    );
  }

  if (recurringQuery.isError) {
    const error = toSafeErrorMessage(t, recurringQuery.error, "common.errors.generic");
    return (
      <Banner tone="critical" title={t("errorLoadingRecurring")} action={{ content: t("retry"), onAction: recurringQuery.refetch }}>
        <p>{error}</p>
      </Banner>
    );
  }

  const recurringEdits = recurringQuery.data || [];

  if (recurringEdits.length === 0) {
    return (
      <EmptyState
        heading={t("noRecurringEdits")}
        action={{ content: t("scheduleNewEdit"), url: "/edit" }}
        image="https://cdn.shopify.com/s/files/1/0533/2089/files/empty-state.svg"
      >
        <Text as="p" tone="subdued">
          {t("noRecurringDesc")}
        </Text>
      </EmptyState>
    );
  }

  return (
    <>
      <BlockStack gap="400">
        {recurringEdits.map((edit) => (
          <Card key={edit.id}>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <InlineStack gap="300" blockAlign="center">
                  <CalendarIcon />
                  <Text variant="headingSm">{edit.field}</Text>
                </InlineStack>
                <Badge tone={String(edit.statusKey || "").toUpperCase() === "ACTIVE" ? "success" : "attention"}>
                  {String(edit.statusKey || "").toUpperCase() === "ACTIVE" ? t("active") : t("paused")}
                </Badge>
              </InlineStack>

              <Text as="p" tone="subdued">
                {t("nextRun")}: {edit.nextRunAt || "-"}
              </Text>

              <Divider />

              <InlineStack gap="200" align="start">
                <Button
                  size="slim"
                  tone={String(edit.statusKey || "").toUpperCase() === "ACTIVE" ? "critical" : "success"}
                  onClick={() => openModal("toggle", edit.id)}
                >
                  {String(edit.statusKey || "").toUpperCase() === "ACTIVE" ? t("pause") : t("resume")}
                </Button>
                <Button
                  size="slim"
                  tone="critical"
                  onClick={() => openModal("cancel", edit.id)}
                >
                  {t("cancel")}
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        ))}
      </BlockStack>

      {/* === Confirmation Modal === */}
      <Modal
        open={modalState.open}
        onClose={closeModal}
        title={
          modalState.type === "cancel"
            ? t("confirmCancelTitle")
            : t("confirmToggleTitle")
        }
        primaryAction={{
          content:
            modalState.type === "cancel" ? t("confirmCancel") : t("confirm"),
          tone: modalState.type === "cancel" ? "critical" : "success",
          onAction: confirmAction,
          loading: toggleMutation.isPending || deleteMutation.isPending,
        }}
        secondaryActions={[
          {
            content: t("back"),
            onAction: closeModal,
            disabled: toggleMutation.isPending || deleteMutation.isPending,
          },
        ]}
      >
        <Modal.Section>
          <Text as="p">
            {modalState.type === "cancel"
              ? t("confirmCancelText")
              : t("confirmToggleText")}
          </Text>
        </Modal.Section>
      </Modal>
    </>
  );
}
