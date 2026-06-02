import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Text, BlockStack, Box, Banner } from "@shopify/polaris";
import { useTranslation } from "react-i18next";

function safeNumber(value, fallback = null) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.floor(number);
}

function safeString(value, fallback = null, maxLength = 120) {
  if (value === undefined || value === null) return fallback;
  const stringValue = String(value).trim();
  if (!stringValue) return fallback;
  return stringValue.length > maxLength
    ? `${stringValue.slice(0, maxLength)}...`
    : stringValue;
}

function safeDateLabel(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const UndoSummary = memo(function UndoSummary({ summary, t }) {
  if (!summary) return null;

  const label = safeString(summary.label);
  const operationId = safeString(summary.operationId, null, 80);
  const affectedProducts = safeNumber(summary.affectedProducts);
  const affectedVariants = safeNumber(summary.affectedVariants);
  const editedAt = safeDateLabel(summary.createdAt || summary.editedAt);

  if (
    affectedProducts === null &&
    affectedVariants === null &&
    !label &&
    !operationId &&
    !editedAt
  ) {
    return null;
  }

  return (
    <Box paddingBlockStart="200">
      <BlockStack gap="100">
        {label ? (
          <Text as="p" variant="bodySm" tone="subdued">
            {t("products:undoEditSummaryLabel", {
              defaultValue: "Edit: {{label}}",
              label,
            })}
          </Text>
        ) : null}

        {editedAt ? (
          <Text as="p" variant="bodySm" tone="subdued">
            {t("products:undoEditEditedAt", {
              defaultValue: "Edited at: {{editedAt}}",
              editedAt,
            })}
          </Text>
        ) : null}

        {affectedProducts !== null ? (
          <Text as="p" variant="bodySm" tone="subdued">
            {t("products:undoEditAffectedProducts", {
              defaultValue: "Affected products: {{count}}",
              count: affectedProducts,
            })}
          </Text>
        ) : null}

        {affectedVariants !== null ? (
          <Text as="p" variant="bodySm" tone="subdued">
            {t("products:undoEditAffectedVariants", {
              defaultValue: "Affected variants: {{count}}",
              count: affectedVariants,
            })}
          </Text>
        ) : null}

        {operationId ? (
          <Text as="p" variant="bodySm" tone="subdued">
            {t("products:undoEditOperationId", {
              defaultValue: "Operation: {{operationId}}",
              operationId,
            })}
          </Text>
        ) : null}
      </BlockStack>
    </Box>
  );
});

function AlertUndo({
  show,
  handleClose,
  undoEditHistory,
  loading = false,
  undoSummary = null,
}) {
  const { t } = useTranslation(["products", "common"]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  const isBusy = loading || isSubmitting;
  const canUndo = typeof undoEditHistory === "function" && !isBusy;

  useEffect(() => {
    if (!show) {
      setSubmitError(null);
      setIsSubmitting(false);
    }
  }, [show]);

  const handleModalClose = useCallback(() => {
    if (isBusy) return;
    setSubmitError(null);
    if (typeof handleClose === "function") {
      handleClose();
    }
  }, [handleClose, isBusy]);

  const handleUndo = useCallback(async () => {
    if (!canUndo) return;

    try {
      setSubmitError(null);
      setIsSubmitting(true);
      await undoEditHistory();
    } catch {
      setSubmitError(
        t("products:undoEditSubmitFailed", {
          defaultValue:
            "Unable to submit the undo request. Please retry or refresh the app.",
        }),
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [canUndo, t, undoEditHistory]);

  const primaryAction = useMemo(
    () => ({
      content: t("products:yesUndoEdit", { defaultValue: "Yes, undo edit" }),
      tone: "critical",
      onAction: handleUndo,
      loading: isBusy,
      disabled: !canUndo,
    }),
    [canUndo, handleUndo, isBusy, t],
  );

  const secondaryActions = useMemo(
    () => [
      {
        content: t("common:cancel", { defaultValue: "Cancel" }),
        onAction: handleModalClose,
        disabled: isBusy,
      },
    ],
    [handleModalClose, isBusy, t],
  );

  return (
    <Modal
      open={Boolean(show)}
      onClose={handleModalClose}
      title={t("products:undoEdit", { defaultValue: "Undo edit" })}
      size="small"
      primaryAction={primaryAction}
      secondaryActions={secondaryActions}
    >
      <Modal.Section>
        <BlockStack gap="200">
          <Text as="p" variant="bodyMd">
            {t("products:confirmUndoMessage", {
              defaultValue:
                "Are you sure you want to undo this edit? This action will attempt to restore the previous product values.",
            })}
          </Text>

          <Banner tone="warning">
            <p>
              {t("products:undoEditDestructiveWarning", {
                defaultValue:
                  "This is an operationally sensitive action. Review the edit details below before continuing.",
              })}
            </p>
          </Banner>

          <UndoSummary summary={undoSummary} t={t} />

          {submitError ? (
            <Banner tone="critical">
              <p>{submitError}</p>
            </Banner>
          ) : null}

          {isBusy ? (
            <Text as="p" variant="bodySm" tone="subdued">
              {t("products:undoEditSubmittingMessage", {
                defaultValue:
                  "Undo is being submitted. Please keep this window open until the request is accepted.",
              })}
            </Text>
          ) : null}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

export default memo(AlertUndo);
