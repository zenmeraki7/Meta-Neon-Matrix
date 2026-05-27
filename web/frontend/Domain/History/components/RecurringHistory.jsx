import React, { useEffect, useState, useCallback } from "react";
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
  Toast,
  Frame,
  Modal,
  Box,
} from "@shopify/polaris";
import { CalendarIcon } from "@shopify/polaris-icons";
import { useTranslation } from "react-i18next";
import { protectedApiDelete, protectedApiGet, protectedApiPut } from "../../../api/protectedApiClient";
import { toSafeErrorMessage } from "../../../utils/frontendError";

export default function RecurringHistory() {
  const { t } = useTranslation();

  // === State Management ===
  const [loading, setLoading] = useState(true);
  const [recurringEdits, setRecurringEdits] = useState([]);
  const [toastState, setToastState] = useState({ active: false, message: "", error: false });
  const [modalState, setModalState] = useState({
    open: false,
    type: null,
    targetId: null,
  });
  const [error, setError] = useState("");

  // === API: Fetch Recurring Edits ===
  const fetchRecurringEdits = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await protectedApiGet("/api/products/recurring/list-summary?limit=50");
      const items = data?.items || data?.data || [];
      setRecurringEdits(items);
    } catch (err) {
      console.error(err);
      setError(toSafeErrorMessage(t, err, "common.errors.generic"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRecurringEdits();
  }, [fetchRecurringEdits]);

  // === API: Pause/Resume Edit ===
  const handleToggleStatus = async (id, currentStatus) => {
    try {
      const nextStatus = currentStatus ? "PAUSED" : "ACTIVE";
      await protectedApiPut(`/api/products/update-recurring-edit/${id}/toggle`, { status: nextStatus }, {
        idempotent: true,
      });

      // Optimistic UI update
      setRecurringEdits((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, statusKey: nextStatus, status: nextStatus === "ACTIVE" ? "Active" : "Inactive" } : item
        )
      );

      setToastState({
        active: true,
        message: nextStatus === "ACTIVE" ? t("resumedSuccessfully") : t("pausedSuccessfully"),
        error: false,
      });
    } catch (err) {
      setToastState({
        active: true,
        message: toSafeErrorMessage(t, err, "common.errors.generic"),
        error: true,
      });
    } finally {
      setModalState({ open: false, type: null, targetId: null });
    }
  };

  // === API: Cancel Edit ===
  const handleCancelEdit = async (id) => {
    try {
      await protectedApiDelete(`/api/products/delete-recurring-edit/${id}`, {
        idempotent: true,
      });

      setRecurringEdits((prev) => prev.filter((edit) => edit.id !== id));
      setToastState({ active: true, message: t("cancelledSuccessfully"), error: false });
    } catch (err) {
      setToastState({
        active: true,
        message: toSafeErrorMessage(t, err, "common.errors.generic"),
        error: true,
      });
    } finally {
      setModalState({ open: false, type: null, targetId: null });
    }
  };

  // === Modal Confirmation Handlers ===
  const openModal = (type, id) => setModalState({ open: true, type, targetId: id });
  const closeModal = () => setModalState({ open: false, type: null, targetId: null });

  const confirmAction = () => {
    const { type, targetId } = modalState;
    if (!targetId || !type) return;
    if (type === "cancel") handleCancelEdit(targetId);
    else if (type === "toggle") {
      const target = recurringEdits.find((r) => r.id === targetId);
      if (target) {
        const isActive = String(target.statusKey || "").toUpperCase() === "ACTIVE";
        handleToggleStatus(targetId, isActive);
      }
    }
  };

  // === Toast ===
  const toastMarkup = toastState.active ? (
    <Toast
      content={toastState.message}
      error={toastState.error}
      duration={4000}
      onDismiss={() => setToastState({ active: false, message: "", error: false })}
    />
  ) : null;

  // === Render States ===
  if (loading) {
    return (
      <BlockStack align="center" gap="400" padding="400">
        <Spinner accessibilityLabel={t("loading")} size="large" />
        <Text tone="subdued">{t("loadingRecurring")}</Text>
      </BlockStack>
    );
  }

  if (error) {
    return (
      <Banner tone="critical" title={t("errorLoadingRecurring")} action={{ content: t("retry"), onAction: fetchRecurringEdits }}>
        <p>{error}</p>
      </Banner>
    );
  }

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
    <Frame>
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
        }}
        secondaryActions={[
          {
            content: t("back"),
            onAction: closeModal,
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

      {toastMarkup}
    </Frame>
  );
}
